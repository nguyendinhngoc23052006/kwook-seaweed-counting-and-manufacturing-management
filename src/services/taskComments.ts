import { supabase } from "../lib/supabaseClient";

// --- Local types (mirrors org_task_comments' jsonb shape) -------------------

export interface TaskComment {
  id: string;
  author_position_id: string;
  author_title: string;
  body: string;
  created_at: string;
}

// Oldest first, same order org_task_comments() returns. Returns [] for a task
// the caller cannot see (the RPC filters rather than errors), so an empty
// thread and "no access" render the same empty state.
export async function listTaskComments(taskId: string): Promise<TaskComment[]> {
  const client = supabase();
  const { data, error } = await client.rpc("org_task_comments", {
    p_task: taskId,
  });
  if (error) throw error;
  return Array.isArray(data) ? (data as TaskComment[]) : [];
}

// Authored server-side as whichever of the task's two seats the caller
// currently holds; org_add_task_comment() refuses (42501) a caller with no
// seat on the task, including an admin reading only via the third branch of
// org_can_see_task().
export async function addTaskComment(taskId: string, body: string): Promise<string> {
  const trimmed = body.trim();
  if (!trimmed) throw new Error("comment body required");
  const client = supabase();
  const { data, error } = await client.rpc("org_add_task_comment", {
    p_task: taskId,
    p_body: trimmed,
  });
  if (error) throw error;
  return data as string;
}
