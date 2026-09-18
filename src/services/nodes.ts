import { supabase } from "../lib/supabaseClient";

// --- Local types (mirrors of the shared org types, ported per-repo) --------

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
  | "view_camera_data";
// export_camera_data is not in this union: PR #40 retired that capability
// key entirely (view implies export now).

export interface NodeNature {
  key: string;
  name_vi: string;
  name_en: string;
  sort_order: number;
}

export interface OrgNode {
  id: string;
  parent_id: string | null;
  name: string;
  name_en: string | null;
  nature_key: string | null;
  sort_order: number;
  active: boolean;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
}

export interface OrgTreeSeat {
  position_id: string;
  title: string;
  rank_key: string;
  rank_ordinal: number;
  reports_to: string | null;
  person_id: string | null;
  person_name: string | null;
  employee_code: string | null;
}

// `nature` is the INHERITED answer (nearest ancestor that sets one, null until
// somebody does); `nature_set_here` is this node's own column. `capabilities`
// lists only what this node was explicitly granted — there is no inheritance.
export interface OrgTreeNode {
  id: string;
  parent_id: string | null;
  name: string;
  name_en: string | null;
  active: boolean;
  nature: string | null;
  nature_set_here: string | null;
  capabilities: CapabilityKey[];
  seats: OrgTreeSeat[];
}

// The whole tree arrives as one jsonb document from org_tree(), which resolves
// the inherited nature and each node's explicit grants server-side. Arrays are
// normalised here for the same reason normalizeChart() does it: the JSON
// crosses a system boundary, and a null where the UI expects [] crashes the
// chart rather than showing an empty box.
export function normalizeOrgTree(raw: unknown): OrgTreeNode[] {
  if (!Array.isArray(raw)) return [];
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const seats = (xs: unknown): OrgTreeSeat[] =>
    Array.isArray(xs)
      ? (xs as Partial<OrgTreeSeat>[]).map((s) => ({
          position_id: s.position_id ?? "",
          title: s.title ?? "",
          rank_key: s.rank_key ?? "",
          rank_ordinal: typeof s.rank_ordinal === "number" ? s.rank_ordinal : 0,
          reports_to: str(s.reports_to),
          person_id: str(s.person_id),
          person_name: str(s.person_name),
          employee_code: str(s.employee_code),
        }))
      : [];
  const capabilities = (xs: unknown): CapabilityKey[] =>
    Array.isArray(xs) ? (xs.filter((k) => typeof k === "string") as CapabilityKey[]) : [];
  return (raw as Partial<OrgTreeNode>[]).map((n) => ({
    id: n.id ?? "",
    parent_id: str(n.parent_id),
    name: n.name ?? "",
    name_en: str(n.name_en),
    active: n.active !== false,
    nature: str(n.nature),
    nature_set_here: str(n.nature_set_here),
    capabilities: capabilities(n.capabilities),
    seats: seats(n.seats),
  }));
}

// Returns [] for a caller the model does not know yet — org_tree() refuses to
// let a fresh signup enumerate the company, so an empty list is a real answer.
export async function getOrgTree(): Promise<OrgTreeNode[]> {
  const client = supabase();
  const { data, error } = await client.rpc("org_tree");
  if (error) throw error;
  return normalizeOrgTree(data);
}

// Natures are rows, not an enum: this list grows with an INSERT, so the picker
// reads it instead of hard-coding 'field' and 'office'.
export async function listNodeNatures(): Promise<NodeNature[]> {
  const client = supabase();
  const { data, error } = await client.from("node_natures").select("*").order("sort_order");
  if (error) throw error;
  return (data ?? []) as NodeNature[];
}

// A plain insert: the create_child_node capability is checked by both the
// policy and the trigger, and created_by/created_at are stamped by the
// database — anything the client sends for them is overwritten.
export async function createChildNode(input: {
  parentId: string;
  name: string;
  nameEn?: string | null;
  natureKey?: string | null;
  sortOrder?: number;
}): Promise<OrgNode> {
  const trimmed = input.name.trim();
  if (!trimmed) throw new Error("node name required");
  if (!input.parentId) throw new Error("parent node required");
  const client = supabase();
  const { data, error } = await client
    .from("org_nodes")
    .insert({
      parent_id: input.parentId,
      name: trimmed,
      name_en: input.nameEn?.trim() || null,
      nature_key: input.natureKey ?? null,
      sort_order: input.sortOrder ?? 100,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as OrgNode;
}

export async function renameNode(
  id: string,
  name: string,
  nameEn?: string | null,
): Promise<OrgNode> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("node name required");
  const client = supabase();
  const patch: Pick<OrgNode, "name"> & Partial<Pick<OrgNode, "name_en">> = {
    name: trimmed,
  };
  if (nameEn !== undefined) patch.name_en = nameEn?.trim() || null;
  const { data, error } = await client
    .from("org_nodes")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return data as OrgNode;
}

// Nature decides which doorway the UI opens for this node and everything under
// it that sets none of its own; null hands the question back to the nearest
// ancestor. It is in no permission predicate, so this changes nobody's access.
export async function setNodeNature(id: string, natureKey: string | null): Promise<OrgNode> {
  const client = supabase();
  const { data, error } = await client
    .from("org_nodes")
    .update({ nature_key: natureKey })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return data as OrgNode;
}

// Reparenting is reserved to org_admin() by org_guard_nodes (8.8) -- a real
// parent_id change for anyone else raises a Postgres error from the trigger,
// which is left to surface as-is rather than pre-validated here.
export async function moveNode(nodeId: string, newParentId: string): Promise<OrgNode> {
  if (!nodeId || !newParentId) throw new Error("node and new parent required");
  if (nodeId === newParentId) throw new Error("a node cannot be its own parent");
  const client = supabase();
  const { data, error } = await client
    .from("org_nodes")
    .update({ parent_id: newParentId })
    .eq("id", nodeId)
    .select("*")
    .single();
  if (error) throw error;
  return data as OrgNode;
}

export async function setNodeActive(id: string, active: boolean): Promise<OrgNode> {
  const client = supabase();
  const { data, error } = await client
    .from("org_nodes")
    .update({ active })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return data as OrgNode;
}

export interface NodeHistoryEntry {
  at: string;
  actor_person_id: string | null;
  action: "insert" | "update";
  before_json: unknown;
  after_json: unknown;
}

// Mirrors listCapabilityHistory()'s defensive shape (src/services/capabilities.ts):
// org_node_history() itself returns zero rows for an unauthorized caller rather
// than raising, so there is no error path to distinguish here.
export async function getNodeHistory(nodeId: string): Promise<NodeHistoryEntry[]> {
  const client = supabase();
  const { data, error } = await client.rpc("org_node_history", { p_node: nodeId });
  if (error) throw error;
  return Array.isArray(data) ? (data as NodeHistoryEntry[]) : [];
}

// --- Pure walks over the one snapshot -----------------------------------
// The tree is arbitrarily deep and arrives whole, so every screen derives what
// it needs from that array instead of asking the database again per level.

export function findNode(
  nodes: OrgTreeNode[],
  nodeId: string | undefined,
): OrgTreeNode | undefined {
  if (!nodeId) return undefined;
  return nodes.find((n) => n.id === nodeId);
}

export function rootNode(nodes: OrgTreeNode[]): OrgTreeNode | undefined {
  return nodes.find((n) => n.parent_id === null);
}

// One pass over the snapshot, then every lookup is O(1). The chart walks the
// whole company and asks for the children of each box it draws, so filtering
// the flat array per node made drawing the tree quadratic in its size.
export function indexChildren(nodes: OrgTreeNode[]): Map<string, OrgTreeNode[]> {
  const byParent = new Map<string, OrgTreeNode[]>();
  for (const node of nodes) {
    if (node.parent_id === null) continue;
    const siblings = byParent.get(node.parent_id);
    if (siblings) siblings.push(node);
    else byParent.set(node.parent_id, [node]);
  }
  return byParent;
}

export function childrenOf(children: Map<string, OrgTreeNode[]>, nodeId: string): OrgTreeNode[] {
  return children.get(nodeId) ?? [];
}

// Every id under nodeId (not including nodeId itself), one BFS over the same
// index childrenOf() already reads. org_guard_nodes refuses a cycle regardless,
// this just keeps a doomed reparent choice off the picker in the first place.
export function descendantIds(children: Map<string, OrgTreeNode[]>, nodeId: string): string[] {
  const out: string[] = [];
  const queue = [...childrenOf(children, nodeId)];
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) continue;
    out.push(next.id);
    queue.push(...childrenOf(children, next.id));
  }
  return out;
}

// Root first, the node itself last. Depth-capped like the SQL walks: the
// triggers refuse a cycle, but a breadcrumb that never ends is a frozen tab
// rather than an error message.
export function breadcrumbOf(nodes: OrgTreeNode[], nodeId: string): OrgTreeNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const trail: OrgTreeNode[] = [];
  let current = byId.get(nodeId);
  let depth = 0;
  while (current && depth < 100000) {
    trail.unshift(current);
    current = current.parent_id ? byId.get(current.parent_id) : undefined;
    depth += 1;
  }
  return trail;
}

// A node is "effectively active" only if it, and every ancestor above it, has
// active = true (20260924000000_freeze_inactive_subtrees.sql,
// org_node_effectively_active) -- deactivating a node never cascades the
// column to its children, so a child under an inactive parent still reads
// active=true on its own row. Same iterative walk-up-the-parent-chain shape as
// breadcrumbOf, depth-capped the same way; every write-gating check in the UI
// imports this rather than re-walking parent_id itself.
export function isNodeEffectivelyActive(nodes: OrgTreeNode[], nodeId: string): boolean {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let current = byId.get(nodeId);
  if (!current) return false;
  let depth = 0;
  while (current && depth < 100000) {
    if (!current.active) return false;
    current = current.parent_id ? byId.get(current.parent_id) : undefined;
    depth += 1;
  }
  return true;
}

// Seats a new seat in this node may report to: its own, then every ancestor's.
// Ancestors come first because that is where a manager usually sits.
export function managerSeatChoices(
  nodes: OrgTreeNode[],
  nodeId: string,
): { seat: OrgTreeSeat; node: OrgTreeNode }[] {
  return breadcrumbOf(nodes, nodeId)
    .reverse()
    .flatMap((n) => n.seats.map((seat) => ({ seat, node: n })));
}

// The database admits exactly one live seat with no manager above it. When one
// already exists, "no manager" is not an option the UI may offer.
export function hasRootSeat(nodes: OrgTreeNode[]): boolean {
  return nodes.some((n) => n.seats.some((seat) => seat.reports_to === null));
}

// --- Chart search --------------------------------------------------------
// Vietnamese text search needs its own fold: NFD alone leaves the
// combining marks and the letter đ/Đ, which NFD does not decompose, before a
// plain substring test.
export function foldSearchText(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
}

function nodeSearchText(node: OrgTreeNode): string {
  const seatText = node.seats
    .map((s) => `${s.title} ${s.person_name ?? ""} ${s.employee_code ?? ""}`)
    .join(" ");
  return foldSearchText(`${node.name} ${node.name_en ?? ""} ${seatText}`);
}

// One fold per node, done once per snapshot rather than once per keystroke --
// the search box calls this behind a useMemo keyed on the snapshot, then
// matchingNodeIds() below does a cheap substring scan on every keystroke.
export function buildSearchIndex(nodes: OrgTreeNode[]): Map<string, string> {
  return new Map(nodes.map((n) => [n.id, nodeSearchText(n)]));
}

export function matchingNodeIds(index: Map<string, string>, query: string): Set<string> {
  const q = foldSearchText(query.trim());
  if (!q) return new Set();
  const matches = new Set<string>();
  for (const [id, text] of index) {
    if (text.includes(q)) matches.add(id);
  }
  return matches;
}

// Every node that must be expanded (children visible) for every match to be
// reachable from a root -- the strict ancestors of each match. The match
// itself needs no entry here: its own box always renders once its parent is
// expanded; only its children need a reason to show, and search doesn't force
// those open. Builds the id lookup once rather than calling breadcrumbOf per
// match, which would rebuild it on every call.
export function ancestorsToExpand(nodes: OrgTreeNode[], matchedIds: Set<string>): Set<string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const expand = new Set<string>();
  for (const id of matchedIds) {
    const match = byId.get(id);
    let current = match?.parent_id ? byId.get(match.parent_id) : undefined;
    let depth = 0;
    while (current && depth < 100000) {
      expand.add(current.id);
      current = current.parent_id ? byId.get(current.parent_id) : undefined;
      depth += 1;
    }
  }
  return expand;
}
