import { supabase } from "../lib/supabaseClient";

// Local type definitions: this repo has no generated src/types/database.ts.
// Named to match the source repo exactly so other ported files resolve them.

// Mirrors the CHECK constraint on public.notifications.kind
// (supabase/migrations/20260923030000_notifications.sql).
export type NotificationKind =
  | "task_assigned"
  | "task_submitted"
  | "task_accepted"
  | "task_rejected"
  | "task_handed_across"
  | "task_commented"
  | "capability_changed";

export interface Notification {
  id: string;
  kind: NotificationKind;
  payload: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}

// Every read/write goes through an RPC (org_notifications /
// org_mark_notification_read / org_unread_notification_count) — same posture
// as task_comments: the table has no insert or delete policy for anyone but
// the trigger's SECURITY DEFINER context, so a browser only ever gets in
// through these three doors.

function notifications(raw: unknown): Notification[] {
  return Array.isArray(raw) ? (raw as Notification[]) : [];
}

// Keyset-paged, newest-first: `before` filters strictly older than the last
// row the caller has already seen, same style as the source app's
// listMyNotifications but matching org_notifications' own p_before/p_limit
// signature rather than the source's unread-only filter.
export async function listNotifications(before?: string): Promise<Notification[]> {
  const { data, error } = await supabase().rpc("org_notifications", {
    p_before: before ?? null,
    p_limit: 50,
  });
  if (error) throw error;
  return notifications(data);
}

export async function markNotificationRead(id: string): Promise<void> {
  const { error } = await supabase().rpc("org_mark_notification_read", {
    p_id: id,
  });
  if (error) throw error;
}

export async function unreadNotificationCount(): Promise<number> {
  const { data, error } = await supabase().rpc("org_unread_notification_count");
  if (error) throw error;
  return typeof data === "number" ? data : 0;
}
