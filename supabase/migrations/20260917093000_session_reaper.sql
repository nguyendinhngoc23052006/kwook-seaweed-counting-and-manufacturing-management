-- Close the sessions whose camera vanished - honestly.
--
-- A session ends for a reason the system WATCHED happen: a sign-out, a stop
-- button, a revoke. Those are the four values 20260916170000 shipped, and every
-- one of them is written by the thing that caused it, in the instant it
-- happened. There is a fifth ending nobody is present for: the phone's battery
-- dies, the tab is killed by the OS, the Wi-Fi bridge in the wet room drops.
-- Nothing writes ended_at, so the session stays open forever - the station is
-- permanently "occupied" and a coverage report counts an empty wall as recorded.
--
-- This migration closes those, with end_reason = 'lost', at the last moment the
-- camera PROVED it was alive.
--
--   ended_at = greatest(last_evidence_at, started_at)     NEVER now()
--
-- now() is the tempting value and it is a lie. A phone whose battery died on
-- Friday afternoon and is plugged back in on Monday would have its Friday
-- session stamped Monday morning: seventy-two hours of asserted recording that
-- never happened, added to every uptime percentage, every "minutes lost to mode
-- transitions" line and every station comparison in the report. The reaper runs
-- at a time that has nothing to do with the event it is describing, so its own
-- clock is not evidence of anything. The last heartbeat is. started_at is the
-- floor because a session that never heartbeat still proved it existed once -
-- and because capture_sessions_ends_after_start would reject anything lower.
--
-- greatest() ignores NULLs in Postgres, so a session predating last_evidence_at
-- (or one that died before its first heartbeat) closes at started_at, not NULL.
--
-- Deliberately NOT clamped to now(): the honesty of last_evidence_at is the
-- heartbeat trigger's job (20260917092000, same clamp device_touch_last_seen
-- already applies to devices.last_seen_at). A forged future heartbeat here makes
-- a session UN-reapable - the station visibly stays occupied - rather than
-- silently fabricating a future ended_at. A stuck station is a complaint; an
-- inflated uptime figure is not.
--
-- ------------------------------------------------------------ rule 8: queue
--
-- "Cron -> Queue, never Cron alone." Cron Triggers do not retry: a tick that
-- fails - a lock timeout, a statement timeout mid-batch, a deploy restarting the
-- database - is simply skipped, and the sessions it was going to close stay open
-- until somebody notices. So the schedule does not do the work. One scheduled
-- job ENQUEUES the candidates; a second drains the queue and removes a message
-- only after that session's close has actually committed. A failed close leaves
-- its message in the queue, its visibility timeout expires, and the next tick
-- picks it up again.
--
-- Verified: 2026-09-17
--   pgmq 1.5.1 and pg_cron 1.6.4 are both listed as available extensions on this
--   project (Postgres 17.6.1.166 - pgmq requires 15.6.1.143+), neither installed
--   yet, so this migration installs both as `postgres`.
--   - Queues / pgmq: https://supabase.com/docs/guides/queues/pgmq  ("Enable the
--     extension: create extension pgmq;") and
--     https://supabase.com/docs/guides/queues/quickstart (Dashboard equivalent:
--     Integrations -> Queues -> enable pgmq). Queues are NOT exposed over the
--     Data API unless "Expose Queues via PostgREST" is toggled on, which we
--     leave off - the browser has no business reading this queue.
--   - Cron / pg_cron: https://supabase.com/docs/guides/cron/install (SQL tab:
--     `create extension pg_cron with schema pg_catalog;` plus the two cron-schema
--     grants below; Dashboard equivalent: Integrations -> Cron -> enable
--     pg_cron). Scheduling is `cron.schedule(job_name, schedule, command)` with
--     standard five-field cron syntax, per
--     https://supabase.com/docs/guides/functions/schedule-functions
--
-- pgmq is chosen over a hand-rolled job table because it is available here
-- today: it already gives visibility timeouts, read_ct, and an archive, which is
-- exactly the retry semantics rule 8 asks for, and none of it has to be written
-- or maintained. Everything below is pure SQL in this migration - the human
-- opens no terminal and clicks nothing.

-- Both extensions are guarded on pg_available_extensions rather than written
-- bare. On Supabase both are available, so both branches below install and this
-- migration does exactly what the paragraph above describes. On a plain Postgres
-- - the throwaway cluster a migration is rehearsed against before it is trusted
-- against the real thing - neither exists, and a bare `create extension` aborts
-- the file. That would mean the one migration carrying the reaper is also the
-- one migration nobody can dry-run, which is how a schema stops being
-- reproducible from its files. Skipping leaves the two functions defined and
-- unscheduled: the rest of the schema is verifiable, and the queue plumbing is
-- absent rather than half-built.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pgmq') then
    execute 'create extension if not exists pgmq';
    -- pgmq.create() raises if the queue's tables already exist, so ask first.
    if not exists (select 1 from pgmq.list_queues() where queue_name = 'lost_capture_sessions') then
      perform pgmq.create('lost_capture_sessions');
    end if;
  else
    raise warning 'pgmq unavailable: queue not created, reaper left unscheduled';
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    execute 'create extension if not exists pg_cron with schema pg_catalog';
    execute 'grant usage on schema cron to postgres';
    execute 'grant all privileges on all tables in schema cron to postgres';
  else
    raise warning 'pg_cron unavailable: reaper left unscheduled';
  end if;
end $$;

-- ------------------------------------------------------------------ enqueue

-- Staleness threshold: 5 minutes, which is TEN heartbeats.
--
-- The camera posts a heartbeat every 30 seconds (src/pages/Capture.tsx:393), and
-- the same tick awaits an outbox flush before returning, so one slow upload on
-- factory Wi-Fi already delays the next beat. A phone whose screen has locked is
-- worse: browsers clamp timers in a hidden tab to roughly one per minute, so a
-- camera that is genuinely recording can legitimately go minutes between beats.
--
-- Too short and we close a session that is still running, and because ended_at
-- is the LAST evidence rather than now(), we amputate every minute it goes on to
-- produce. Too long and the station stays occupied: capture_sessions has a
-- partial unique index on (station_id) where ended_at is null
-- (20260917092000), so the replacement phone cannot open a session at that
-- station until this reaper frees it - a shift waits on the cron.
-- Ten beats is the widest window that still clears a station inside a tea break.
create or replace function enqueue_lost_capture_sessions() returns bigint
  language plpgsql
  set search_path = public, pgmq as $$
declare
  candidate uuid;
  queued bigint := 0;
begin
  for candidate in
    select s.id
      from capture_sessions s
     where s.ended_at is null
       and greatest(s.last_evidence_at, s.started_at) < now() - interval '5 minutes'
       -- Skip what is already in flight. Without this, a drain that keeps
       -- failing collects one fresh duplicate per session per minute forever.
       and not exists (
         select 1
           from pgmq.q_lost_capture_sessions q
          where (q.message ->> 'session_id')::uuid = s.id
       )
  loop
    perform pgmq.send('lost_capture_sessions', jsonb_build_object('session_id', candidate));
    queued := queued + 1;
  end loop;
  return queued;
end $$;

-- -------------------------------------------------------------------- drain

-- Visibility timeout of 120s against a 60s tick: a message being worked on is
-- never handed to the next tick as well, and a message whose close failed is
-- retried about two minutes later.
--
-- The per-message exception block is the point of the queue. Without it, one
-- session that cannot be closed aborts the whole transaction and takes every
-- other camera's close down with it; with it, the poison message alone keeps its
-- place in the queue and everything else commits.
create or replace function drain_lost_capture_sessions() returns bigint
  language plpgsql
  set search_path = public, pgmq as $$
declare
  msg record;
  handled bigint := 0;
begin
  for msg in select * from pgmq.read('lost_capture_sessions', 120, 100)
  loop
    begin
      -- `ended_at is null` makes this idempotent AND makes a duplicate message
      -- harmless: a session already closed - by this reaper, by a revoke, or by
      -- the phone itself coming back and signing off - is left exactly as it is.
      update capture_sessions
         set ended_at = greatest(last_evidence_at, started_at),
             end_reason = 'lost'
       where id = (msg.message ->> 'session_id')::uuid
         and ended_at is null;

      perform pgmq.delete('lost_capture_sessions', msg.msg_id);
      handled := handled + 1;
    exception
      when others then
        -- Not deleted: the message stays queued and a later tick retries it.
        raise warning 'reaper: capture session % not closed (%), left queued',
          msg.message ->> 'session_id', sqlerrm;
    end;
  end loop;
  return handled;
end $$;

-- Postgres grants EXECUTE on new functions to PUBLIC. These two close sessions
-- across every tenant; only the scheduler (running as postgres, the owner) may
-- call them.
revoke execute on function public.enqueue_lost_capture_sessions() from public;
revoke execute on function public.drain_lost_capture_sessions() from public;

-- ---------------------------------------------------- a reaped end is final

-- A returning phone must not be able to undo its own reaping. session_device_end
-- (20260916170000) lets a device UPDATE its own session row, and its with-check
-- constrains only device_id and tenant_id - so the phone that reappears on
-- Monday could set ended_at back to NULL and claim the whole weekend, which is
-- the exact figure this migration exists to refuse. It could equally rewrite
-- end_reason from 'lost' to 'stopped' and launder an outage into a clean
-- sign-off.
--
-- Nothing legitimate rewrites an ending: every writer in this schema - the
-- device, the owner, end_sessions_on_revoke, the drain above - only ever closes
-- a session whose ended_at is still null. So an ending, once written, is final.
create or replace function capture_session_end_is_final() returns trigger
  language plpgsql as $$
begin
  if old.ended_at is not null
     and (new.ended_at is distinct from old.ended_at
          or new.end_reason is distinct from old.end_reason) then
    raise exception 'capture session % ended at % (%); its ending cannot be rewritten',
      old.id, old.ended_at, old.end_reason
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists capture_session_end_is_final on capture_sessions;
create trigger capture_session_end_is_final
  before update of ended_at, end_reason on capture_sessions
  for each row execute function capture_session_end_is_final();

-- ----------------------------------------------------------------- schedule

-- Both jobs every minute. The enqueue tick is cheap (one indexed scan of open
-- sessions); the drain tick does the writes and is the one allowed to fail.
--
-- Scheduling only happens where BOTH extensions landed. A drain job scheduled
-- without pgmq would run every minute and fail every minute; an enqueue job
-- without a queue to enqueue into is the same. The guard is on the installed
-- extensions (pg_extension), not the available ones, so a partial install
-- schedules nothing rather than half the pair.
do $$
declare
  existing text;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_extension where extname = 'pgmq') then
    raise warning 'pg_cron or pgmq absent: reaper functions exist but are not scheduled';
    return;
  end if;

  for existing in
    select jobname from cron.job
     where jobname in ('reap-lost-sessions-enqueue', 'reap-lost-sessions-drain')
  loop
    perform cron.unschedule(existing);
  end loop;

  perform cron.schedule(
    'reap-lost-sessions-enqueue',
    '* * * * *',
    'select public.enqueue_lost_capture_sessions()'
  );

  perform cron.schedule(
    'reap-lost-sessions-drain',
    '* * * * *',
    'select public.drain_lost_capture_sessions()'
  );
end $$;
