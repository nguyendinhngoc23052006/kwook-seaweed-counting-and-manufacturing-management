import { supabase } from "../lib/supabaseClient";
import type { CapabilityReach } from "../types/camera";

// Local type definitions: this repo has no generated src/types/database.ts.
// Named to match the source repo exactly so other ported files resolve them.
export type CapabilityKey =
  | "assign_work_down"
  | "accept_or_reject_submission"
  | "hand_across_to_peer"
  | "create_child_node"
  | "appoint_into_seat_below"
  | "issue_document_for_acknowledgment"
  | "set_deadline_and_weight"
  | "view_subtree_workload"
  | "evaluate_people_below"
  | "configure_child_capabilities"
  | "maintain_person_profile"
  | "maintain_bank_details"
  | "manage_camera_devices"
  | "view_camera_data"
  | "view_attendance_below"
  | "enroll_own_face"
  | "correct_attendance";

export interface CapabilityType {
  key: CapabilityKey;
  sort_order: number;
  note: string;
}

export interface NodeCapability {
  id: number;
  node_id: string;
  capability_key: CapabilityKey;
  granted: boolean;
  effective_from: string;
  reason: string | null;
  created_at: string;
  created_by: string | null;
}

export interface CapabilityPreviewRow {
  node_id: string;
  node_name: string;
  currently_granted: boolean;
  effect: string;
}

export interface CapabilityHistoryEntry {
  at: string;
  actor_person_id: string | null;
  action: "grant" | "revoke";
  before_json: unknown;
  after_json: { capability_key: string; granted: boolean; reason: string | null };
}

// The vocabulary is code -- the table is SELECT-only over REST -- so this
// list changes only when a migration seeds a new key. Labels are not stored:
// the UI renders t(`capability.${key}`).
export async function listCapabilityTypes(): Promise<CapabilityType[]> {
  const client = supabase();
  const { data, error } = await client.from("capability_types").select("*").order("sort_order");
  if (error) throw error;
  return (data ?? []) as CapabilityType[];
}

// The whole ledger for one node, newest first -- grants and revokes alike,
// because a revoke IS a row. The head row per capability_key is what is true
// now; everything under it is what was true before, which is the question
// this table exists to answer. There is no inheritance, so these rows are
// the complete account of what this node can do.
export async function listNodeGrants(nodeId: string): Promise<NodeCapability[]> {
  const client = supabase();
  const { data, error } = await client
    .from("node_capabilities")
    .select("*")
    .eq("node_id", nodeId)
    .order("effective_from", { ascending: false })
    .order("id", { ascending: false });
  if (error) throw error;
  return (data ?? []) as NodeCapability[];
}

// Every grant/subtree/capability event, oldest constraint enforced server-side
// by org_capability_history() -- only org_admin() or a caller holding
// configure_child_capabilities reaching this node sees anything; everyone
// else gets an empty list, not an error.
export async function listCapabilityHistory(
  nodeId: string,
  capabilityKey?: CapabilityKey,
): Promise<CapabilityHistoryEntry[]> {
  const client = supabase();
  const { data, error } = await client.rpc("org_capability_history", {
    p_node: nodeId,
    p_key: capabilityKey ?? null,
  });
  if (error) throw error;
  return Array.isArray(data) ? (data as CapabilityHistoryEntry[]) : [];
}

// Every write goes through the one RPC; it skips nodes already in the
// requested state and returns how many rows it actually wrote.
async function setCapability(input: {
  nodeId: string;
  capabilityKey: CapabilityKey;
  granted: boolean;
  subtree: boolean;
  reason?: string | null;
}): Promise<number> {
  if (!input.nodeId) throw new Error("node required");
  const client = supabase();
  const { data, error } = await client.rpc("org_set_capability", {
    p_node_id: input.nodeId,
    p_capability_key: input.capabilityKey,
    p_granted: input.granted,
    p_subtree: input.subtree,
    p_reason: input.reason?.trim() || null,
  });
  if (error) throw error;
  return data as number;
}

export function grantCapability(input: {
  nodeId: string;
  capabilityKey: CapabilityKey;
  reason?: string | null;
}): Promise<number> {
  return setCapability({ ...input, granted: true, subtree: false });
}

export function revokeCapability(input: {
  nodeId: string;
  capabilityKey: CapabilityKey;
  reason?: string | null;
}): Promise<number> {
  return setCapability({ ...input, granted: false, subtree: false });
}

// One explicit row per node in the subtree, not one inherited row at the
// top -- that is what keeps "why can this person do that?" a single query.
// Hundreds of appended rows with no undo, so call previewCapabilityChange()
// first.
export function grantCapabilityToSubtree(input: {
  nodeId: string;
  capabilityKey: CapabilityKey;
  reason?: string | null;
}): Promise<number> {
  return setCapability({ ...input, granted: true, subtree: true });
}

export function revokeCapabilityInSubtree(input: {
  nodeId: string;
  capabilityKey: CapabilityKey;
  reason?: string | null;
}): Promise<number> {
  return setCapability({ ...input, granted: false, subtree: true });
}

// What a grant or revoke would actually do, per node, before it writes.
// Names no person and returns nothing for a node the caller cannot see.
export async function previewCapabilityChange(input: {
  nodeId: string;
  capabilityKey: CapabilityKey;
  granted: boolean;
  subtree?: boolean;
}): Promise<CapabilityPreviewRow[]> {
  const client = supabase();
  const { data, error } = await client.rpc("org_preview_capability_change", {
    p_node_id: input.nodeId,
    p_capability_key: input.capabilityKey,
    p_granted: input.granted,
    p_subtree: input.subtree ?? false,
  });
  if (error) throw error;
  return (data ?? []) as CapabilityPreviewRow[];
}

// The head row per capability_key whose effective_from has already passed --
// the same rule org_node_has_capability() applies, so the panel and the
// policies cannot disagree about what is true now.
export function currentGrants(rows: NodeCapability[]): Map<string, NodeCapability> {
  const now = Date.now();
  const head = new Map<string, NodeCapability>();
  for (const row of rows) {
    if (Date.parse(row.effective_from) > now) continue;
    if (!head.has(row.capability_key)) head.set(row.capability_key, row);
  }
  return head;
}

// Which nodes each capability the caller holds actually reaches. This is UX
// only -- it decides which buttons exist, never whether a write succeeds --
// and it asks the same functions the RLS policies call, so the two agree.
//
// configure_child_capabilities is asked STRICTLY below: it never reaches the
// node it was granted on, or one grant would let a node write itself the
// rest of the vocabulary. export_camera_data is not in this list: PR #40
// retired that capability key entirely (view implies export now).
const REACH_QUERIES: { key: CapabilityKey; strict: boolean }[] = [
  { key: "create_child_node", strict: false },
  { key: "appoint_into_seat_below", strict: false },
  { key: "configure_child_capabilities", strict: true },
  { key: "maintain_person_profile", strict: false },
  { key: "maintain_bank_details", strict: false },
  { key: "manage_camera_devices", strict: false },
  { key: "view_camera_data", strict: false },
  { key: "view_attendance_below", strict: false },
  { key: "enroll_own_face", strict: false },
  { key: "correct_attendance", strict: false },
];

export async function getMyCapabilityReach(): Promise<CapabilityReach> {
  const client = supabase();
  const [admin, person, rank] = await Promise.all([
    client.rpc("org_admin"),
    client.rpc("org_current_person_id"),
    // The most senior rank the caller holds. The database decides who may edit
    // which seat (org_guard_positions, 20260926000000); this is the same number,
    // read once, so a screen can leave out the seats it would refuse rather than
    // offer them and fail.
    client.rpc("org_my_rank_ordinal"),
  ]);
  if (admin.error) throw admin.error;
  if (person.error) throw person.error;
  if (rank.error) throw rank.error;
  const personId = typeof person.data === "string" ? person.data : null;
  const rankOrdinal = typeof rank.data === "number" ? rank.data : null;

  // An admin reaches every node, and capabilityReaches() below checks isAdmin
  // before it ever reads byKey. Asking the reach queries anyway walks the
  // whole tree per navigation and discards the answer.
  if (admin.data === true) return { personId, isAdmin: true, rankOrdinal, byKey: {} };

  const reaches = await Promise.all(
    REACH_QUERIES.map((query) =>
      client.rpc("org_nodes_reached_with", {
        p_key: query.key,
        p_strict: query.strict,
      }),
    ),
  );

  const byKey: Record<string, string[]> = {};
  REACH_QUERIES.forEach((query, index) => {
    const result = reaches[index];
    if (!result) return;
    if (result.error) throw result.error;
    byKey[query.key] = Array.isArray(result.data)
      ? result.data.filter((id: unknown): id is string => typeof id === "string")
      : [];
  });

  return { personId, isAdmin: false, rankOrdinal, byKey };
}

// The bootstrap pair -- the sysadmin and whoever holds the root seat --
// reaches everything; everyone else reaches exactly the nodes their grants
// name.
export function capabilityReaches(
  reach: CapabilityReach | undefined,
  key: CapabilityKey,
  nodeId: string,
): boolean {
  if (!reach) return false;
  return reach.isAdmin || (reach.byKey[key] ?? []).includes(nodeId);
}

// org_preview_capability_change() returns English sentences it composes
// itself. Map the ones it can produce onto i18n keys; anything new shows
// through verbatim rather than vanishing.
export function previewEffectKey(effect: string): string | null {
  if (effect.startsWith("blocked: you cannot configure")) {
    return "caps.effect_blocked_configure";
  }
  if (effect.startsWith("blocked: you do not hold")) {
    return "caps.effect_blocked_not_held";
  }
  if (effect === "no change") return "caps.effect_no_change";
  if (effect.startsWith("GRANT")) return "caps.effect_grant";
  if (effect.startsWith("REVOKE")) return "caps.effect_revoke";
  return null;
}

export function isChangingEffect(effect: string): boolean {
  return effect.startsWith("GRANT") || effect.startsWith("REVOKE");
}
