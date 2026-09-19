-- The test-bed is gone.
--
-- The legacy stack proved a phone could count seaweed. Everything it taught
-- was carried into the org stack over 20261005000000 (line identity, the
-- capture session, one-open-per-station, clamped evidence, clock skew, the
-- reaper, an ending that cannot be rewritten) and 20261006000000 (pairing
-- creates camera_devices). The floor moved across in the same PRs. Nothing
-- has read these tables since stream-signal and seed.sql moved in this one,
-- and no foreign key outside the stack points into it -- checked, not assumed.
--
-- pairing_codes SURVIVES: its device_id was re-pointed at camera_devices in
-- 20261006000000, and redeem_pairing() still serves the QR flow. It is not
-- part of what is dropped here despite having started life beside it.
--
-- profiles survives too, and so do current_kind(), role_rank() and
-- is_human_at_least(): those are the human ladder that gates the wall and the
-- device/human split, not camera plumbing. Only what the legacy floor owned
-- goes.

begin;

-- Children first. CASCADE would do this in one line and would also silently
-- take anything that turned out to depend on them -- which is exactly the
-- thing worth finding out about rather than absorbing.
drop table if exists public.validation_samples;
drop table if exists public.stream_views;
drop table if exists public.stream_sessions;
drop table if exists public.calibrations;
drop table if exists public.count_events;
drop table if exists public.count_minutes;
drop table if exists public.compliance_events;
drop table if exists public.device_heartbeats;
drop table if exists public.mode_transitions;
drop table if exists public.capture_sessions;
drop table if exists public.devices;
drop table if exists public.stations;
drop table if exists public.lines;
drop table if exists public.operators;

commit;

begin;

-- The functions that existed only to serve those tables. Each one's body
-- referenced a table that no longer exists, so leaving them would leave
-- callables that fail at run time rather than at deploy time.
drop function if exists public.is_active_device();
drop function if exists public.end_sessions_on_revoke();
drop function if exists public.device_touch_last_seen();
drop function if exists public.capture_session_snapshot_placement();
drop function if exists public.capture_session_end_is_final();
drop function if exists public.count_minute_stamp_receipt();
drop function if exists public.enqueue_lost_capture_sessions();
drop function if exists public.drain_lost_capture_sessions();

-- The legacy reaper's schedule and queue. Left behind, the two cron jobs would
-- run every minute forever calling functions that no longer exist -- a pair of
-- failures per minute, in a log nobody reads, for a stack nobody uses. The org
-- reaper (reap-lost-camera-sessions-*) is untouched.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'reap-lost-sessions-enqueue') then
      perform cron.unschedule('reap-lost-sessions-enqueue');
    end if;
    if exists (select 1 from cron.job where jobname = 'reap-lost-sessions-drain') then
      perform cron.unschedule('reap-lost-sessions-drain');
    end if;
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pgmq') then
    if exists (select 1 from pgmq.list_queues() where queue_name = 'lost_capture_sessions') then
      perform pgmq.drop_queue('lost_capture_sessions');
    end if;
  end if;
end $$;

commit;
