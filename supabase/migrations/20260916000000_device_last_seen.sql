-- Fleet health: keep devices.last_seen_at fed from device_heartbeats.
--
-- The Wall reads devices.last_seen_at and nothing ever wrote it, so every
-- camera rendered "never seen" forever. device_heartbeats stays the source of
-- truth for liveness; last_seen_at is a cache of one number per device, so the
-- Wall's 15-second poll reads one row per camera instead of scanning heartbeat
-- history.
--
-- Why a trigger and not a derived max(at) at query time: retention pruning
-- (issue #19) will delete old heartbeats. A derived value dies with the rows it
-- was derived from - a camera that went quiet before the cutoff would flip from
-- "down 3 days" back to "never seen" the moment the pruner ran, which is the
-- one state the Wall must never report wrongly. Writing the projection at
-- insert time survives the pruner. The fact is still recorded once; the cache is
-- machine-maintained, never hand-set.

-- Security definer because a device account is write-only by design: it holds
-- INSERT on device_heartbeats and no UPDATE on devices at all. Running as owner
-- lets the cache move without granting the phone on the factory floor any path
-- to write its own row - it cannot rename itself, reassign its station, or
-- clear revoked_at. The blast radius is the single column below, on the single
-- device the heartbeat names: heartbeat_device_insert already pins device_id to
-- auth.uid(), so new.device_id is the caller's own id and nothing else.
--
-- Monotonic on purpose. A phone that reconnects after a tunnel and flushes a
-- queue of stale heartbeats must not drag liveness backwards; last_seen_at only
-- ever moves forward, so replay is harmless.
--
-- Clamped to server time, because forward-only cuts both ways. `at` is an
-- ordinary insertable column and heartbeat_device_insert constrains only
-- current_kind(), device_id, tenant_id and is_active_device() - never `at` -
-- so a stolen phone can post at = '2999-01-01'. Under the guard above that one
-- row would be permanent: no real heartbeat and no re-run of the backfill could
-- ever move the camera off "live" again, and the Wall would report a phone in
-- someone's pocket as a healthy station. least(new.at, now()) takes the choice
-- away from the device - the insert is happening now, so now() is the most the
-- cache may ever claim.
--
-- No revoke needed: the function returns trigger, and Postgres refuses to call
-- a trigger function directly from SQL.
create or replace function device_touch_last_seen() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  update devices
     set last_seen_at = least(new.at, now())
   where id = new.device_id
     and (last_seen_at is null or last_seen_at < least(new.at, now()));
  return null;
end $$;

drop trigger if exists device_heartbeat_touches_device on device_heartbeats;
create trigger device_heartbeat_touches_device
  after insert on device_heartbeats
  for each row execute function device_touch_last_seen();

-- Backfill from the heartbeats already on disk, so the Wall is right now rather
-- than after each camera's next heartbeat. Created after the trigger so a
-- heartbeat landing mid-migration is caught by one or the other, and guarded by
-- the same forward-only condition - re-running this migration in CI is a no-op.
--
-- Same clamp, applied where it bites for a historical row: rows dated in the
-- future are skipped, not rounded down. A heartbeat forged before this
-- migration existed is evidence of nothing, and clamping it to now() would
-- launder it into the very "live" reading the trigger's clamp exists to deny.
-- distinct on then picks each camera's newest plausible heartbeat, and a device
-- whose only heartbeat is forged correctly stays "never seen".
update devices d
   set last_seen_at = newest.at
  from (
    select distinct on (device_id) device_id, at
      from device_heartbeats
     where at <= now()
     order by device_id, at desc
  ) newest
 where newest.device_id = d.id
   and (d.last_seen_at is null or d.last_seen_at < newest.at);
