-- The task RPCs were never taken away from PUBLIC, so a stranger holding
-- only the publishable key could call them.
--
-- Postgres grants EXECUTE on a new function to PUBLIC by default. Every
-- other migration in this repo closes that immediately -- the pattern is
-- `revoke all on function ... from public, anon;` followed by `grant execute
-- ... to authenticated;` and it appears beside almost every definer function
-- here. 20260922000000_task_flow.sql (lines 614-625) writes the grants and
-- none of the revokes, for all sixteen functions it defines.
--
-- Demonstrated against a full replay, as role `anon` with no JWT at all:
--
--   org_tree()        -> refused, 42501 permission denied   (it has its revoke)
--   org_task_board()  -> returned
--   org_assign_task() -> CREATED A TASK
--
-- The task was assigned from a real manager seat to a real supervisor seat
-- and appeared in tasks with its assigned event, from a caller with no
-- account. org_submit_task and org_accept_task happened to fail further in on
-- a table grant, so the whole lifecycle was not drivable, but creation alone
-- is enough: anyone can inject work into any seat pair whose ids they learn,
-- each insert fires the notification trigger, and the task record is the
-- thing a manager is meant to judge people by.
--
-- The function bodies are not the defence here and were never meant to be.
-- They resolve authority from org_current_person_id(), which is NULL for
-- anon, and several of their guards read that as "no session, trusted
-- context" -- the same shape that lets a migration seed data. That is
-- correct for a migration and wrong for the internet, and the grant is what
-- is supposed to keep those two apart.
--
-- This migration only removes access nobody is supposed to have.
-- `authenticated` keeps every grant it already had, so no client changes.
-- The public careers path is deliberately anon-callable and is NOT touched:
-- org_apply, org_job_board, org_job_posting, org_book_interview_slot,
-- org_interview_slots_for_application, org_mark_cv_uploaded and
-- org_cv_upload_is_open keep their grants.

begin;

-- The six task actions.
revoke all on function public.org_assign_task(uuid, uuid, text, text, numeric, timestamptz) from public, anon;
revoke all on function public.org_submit_task(uuid, text) from public, anon;
revoke all on function public.org_accept_task(uuid, text) from public, anon;
revoke all on function public.org_reject_task(uuid, text) from public, anon;
revoke all on function public.org_hand_task_across(uuid, uuid, text) from public, anon;
revoke all on function public.org_cancel_task(uuid, text) from public, anon;

-- The reads. org_task_board leaks titles, notes, seat titles and holder
-- names for a node; the other two enumerate the seat graph around a seat.
revoke all on function public.org_task_board(uuid) from public, anon;
revoke all on function public.org_assignable_seats(uuid) from public, anon;
revoke all on function public.org_peer_seats(uuid) from public, anon;

-- The helpers defined in the same migration, granted in the same block.
revoke all on function public.org_holds(text) from public, anon;
revoke all on function public.org_is_my_direct_report(uuid) from public, anon;
revoke all on function public.org_position_node(uuid) from public, anon;

-- Trigger functions. Nothing should ever call these directly; they are only
-- reachable at all because of the same default PUBLIC grant. They are
-- revoked from authenticated too -- a trigger runs as the table owner and
-- does not consult the caller's EXECUTE privilege, which is why every other
-- guard function in this repo is revoked from all three roles.
revoke all on function public.task_project_state() from public, anon, authenticated;
revoke all on function public.org_guard_tasks() from public, anon, authenticated;
revoke all on function public.org_guard_task_events() from public, anon, authenticated;
revoke all on function public.task_write_assigned_event() from public, anon, authenticated;

-- Re-assert the intended grants, so this file states the whole contract in
-- one place rather than depending on the reader finding the 2026-09-22 block.
grant execute on function public.org_assign_task(uuid, uuid, text, text, numeric, timestamptz) to authenticated;
grant execute on function public.org_submit_task(uuid, text) to authenticated;
grant execute on function public.org_accept_task(uuid, text) to authenticated;
grant execute on function public.org_reject_task(uuid, text) to authenticated;
grant execute on function public.org_hand_task_across(uuid, uuid, text) to authenticated;
grant execute on function public.org_cancel_task(uuid, text) to authenticated;
grant execute on function public.org_task_board(uuid) to authenticated;
grant execute on function public.org_assignable_seats(uuid) to authenticated;
grant execute on function public.org_peer_seats(uuid) to authenticated;
grant execute on function public.org_holds(text) to authenticated;
grant execute on function public.org_is_my_direct_report(uuid) to authenticated;
grant execute on function public.org_position_node(uuid) to authenticated;

commit;
