import { supabase } from "../lib/supabaseClient";

// --- Local types (mirrors of the shared task types, ported per-repo) --------

export type TaskState = "open" | "submitted" | "done" | "cancelled";

export type TaskEventKind =
  | "assigned"
  | "submitted"
  | "accepted"
  | "rejected"
  | "handed_across"
  | "cancelled";

export interface TaskSeat {
  id: string;
  title: string;
  node_id: string;
  node_name: string;
  band: string;
  person_name: string | null;
}

export interface TaskLastEvent {
  kind: TaskEventKind;
  at: string;
  note: string | null;
}

export interface TaskCard {
  id: string;
  title: string;
  detail: string | null;
  weight: number;
  due_at: string | null;
  state: TaskState;
  created_at: string;
  assigned_by_position_id: string;
  assigned_to_position_id: string;
  to_seat: TaskSeat;
  by_seat: TaskSeat;
  last_event: TaskLastEvent | null;
  // Decided server-side by the same rules the triggers enforce, so a control is
  // drawn only when it would actually work.
  can_submit: boolean;
  can_hand_across: boolean;
  can_decide: boolean;
  can_cancel: boolean;
}

// Four buckets, one round trip. `given` is everything still open that I handed
// out; `awaiting` is the subset sitting in my in-tray waiting to be accepted.
export interface TaskBoard {
  my_seats: AssignableSeat[];
  mine: TaskCard[];
  awaiting: TaskCard[];
  given: TaskCard[];
  node: TaskCard[];
}

export interface AssignableSeat {
  position_id: string;
  title: string;
  node_id: string;
  node_name: string;
  band: string;
  person_name: string | null;
}

export interface PeerSeat {
  position_id: string;
  title: string;
  node_id: string;
  node_name: string;
  person_name: string | null;
}

// Every write goes through an RPC. The ±1 rule, the peer rule and the state
// machine live in the database, in BEFORE triggers, because every one of these
// calls is SECURITY DEFINER and would sail straight past a policy.

function cards(raw: unknown): TaskCard[] {
  return Array.isArray(raw) ? (raw as TaskCard[]) : [];
}

// `undefined` for the node bucket means "don't ask" — the RPC returns [] for a
// node whose workload the caller may not see, which is a real answer, not an
// error, and the screen says so rather than showing a spinner.
export async function getTaskBoard(nodeId?: string): Promise<TaskBoard> {
  const client = supabase();
  const { data, error } = await client.rpc("org_task_board", {
    p_node: nodeId ?? null,
  });
  if (error) throw error;
  const raw = (data ?? {}) as Record<string, unknown>;
  return {
    my_seats: Array.isArray(raw.my_seats) ? (raw.my_seats as AssignableSeat[]) : [],
    mine: cards(raw.mine),
    awaiting: cards(raw.awaiting),
    given: cards(raw.given),
    node: cards(raw.node),
  };
}

// Who this seat may hand work to: its direct reports, plus itself. The database
// answers, so the ±1 rule is not reimplemented in TypeScript where it would
// drift from the trigger that actually enforces it.
export async function listAssignableSeats(fromPositionId: string): Promise<AssignableSeat[]> {
  const client = supabase();
  const { data, error } = await client.rpc("org_assignable_seats", {
    p_from_position: fromPositionId,
  });
  if (error) throw error;
  return Array.isArray(data) ? (data as AssignableSeat[]) : [];
}

export async function listPeerSeats(taskId: string): Promise<PeerSeat[]> {
  const client = supabase();
  const { data, error } = await client.rpc("org_peer_seats", {
    p_task: taskId,
  });
  if (error) throw error;
  return Array.isArray(data) ? (data as PeerSeat[]) : [];
}

export async function assignTask(input: {
  fromPositionId: string;
  toPositionId: string;
  title: string;
  detail?: string | null;
  weight?: number;
  dueAt?: string | null;
}): Promise<string> {
  const title = input.title.trim();
  if (!title) throw new Error("title required");
  const client = supabase();
  const { data, error } = await client.rpc("org_assign_task", {
    p_from_position: input.fromPositionId,
    p_to_position: input.toPositionId,
    p_title: title,
    p_detail: input.detail?.trim() || null,
    p_weight: input.weight ?? 1,
    p_due_at: input.dueAt || null,
  });
  if (error) throw error;
  return data as string;
}

export async function submitTask(taskId: string, note?: string): Promise<void> {
  const client = supabase();
  const { error } = await client.rpc("org_submit_task", {
    p_task: taskId,
    p_note: note?.trim() || null,
  });
  if (error) throw error;
}

export async function acceptTask(taskId: string, note?: string): Promise<void> {
  const client = supabase();
  const { error } = await client.rpc("org_accept_task", {
    p_task: taskId,
    p_note: note?.trim() || null,
  });
  if (error) throw error;
}

// The database insists on a reason. Bouncing work back without saying why is
// how a task ends up going round twice.
export async function rejectTask(taskId: string, note: string): Promise<void> {
  const reason = note.trim();
  if (!reason) throw new Error("reason required");
  const client = supabase();
  const { error } = await client.rpc("org_reject_task", {
    p_task: taskId,
    p_note: reason,
  });
  if (error) throw error;
}

export async function handTaskAcross(
  taskId: string,
  toPositionId: string,
  note?: string,
): Promise<void> {
  const client = supabase();
  const { error } = await client.rpc("org_hand_task_across", {
    p_task: taskId,
    p_to_position: toPositionId,
    p_note: note?.trim() || null,
  });
  if (error) throw error;
}

export async function cancelTask(taskId: string, note?: string): Promise<void> {
  const client = supabase();
  const { error } = await client.rpc("org_cancel_task", {
    p_task: taskId,
    p_note: note?.trim() || null,
  });
  if (error) throw error;
}

// --- Pure helpers the screens share --------------------------------------

export function isOverdue(task: TaskCard, now = Date.now()): boolean {
  if (!task.due_at || task.state === "done" || task.state === "cancelled") {
    return false;
  }
  return Date.parse(task.due_at) < now;
}

// Soonest deadline first, undated last, then oldest first. The same order the
// RPC returns, repeated here because the screens re-sort after a local change
// rather than refetching the whole board.
export function byUrgency(a: TaskCard, b: TaskCard): number {
  if (a.due_at && b.due_at) {
    const diff = Date.parse(a.due_at) - Date.parse(b.due_at);
    if (diff !== 0) return diff;
  } else if (a.due_at !== b.due_at) {
    return a.due_at ? -1 : 1;
  }
  return Date.parse(a.created_at) - Date.parse(b.created_at);
}
