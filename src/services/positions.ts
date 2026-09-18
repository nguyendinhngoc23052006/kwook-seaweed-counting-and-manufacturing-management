import { supabase } from "../lib/supabaseClient";

// Local type definitions: this repo has no generated src/types/database.ts.
// Named to match the source repo exactly so other ported files resolve them.
export interface Rank {
  id: string;
  key: string;
  name_vi: string;
  name_en: string | null;
  ordinal: number;
  active: boolean;
  created_at: string;
  created_by: string | null;
}

export interface Position {
  id: string;
  node_id: string;
  rank_id: string;
  reports_to_position_id: string | null;
  title: string;
  title_en: string | null;
  abolished_at: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
}

// Ordered by ordinal because that is the ordinal's only job outside the one
// coherence check in the database. Nothing here reads its value.
export async function listRanks(): Promise<Rank[]> {
  const { data, error } = await supabase()
    .from("ranks")
    .select("*")
    .eq("active", true)
    .order("ordinal");
  if (error) throw error;
  return (data ?? []) as Rank[];
}

// The OFFICE doorway's first half: the seat is created and stands empty until
// somebody is seated in it. reportsToPositionId is null only for the CEO seat,
// which the database admits exactly once.
export async function createPosition(input: {
  nodeId: string;
  rankId: string;
  title: string;
  titleEn?: string | null;
  reportsToPositionId: string | null;
}): Promise<Position> {
  const title = input.title.trim();
  if (!title) throw new Error("position title required");
  if (!input.nodeId) throw new Error("node required");
  if (!input.rankId) throw new Error("rank required");
  const { data, error } = await supabase()
    .from("positions")
    .insert({
      node_id: input.nodeId,
      rank_id: input.rankId,
      title,
      title_en: input.titleEn?.trim() || null,
      reports_to_position_id: input.reportsToPositionId,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as Position;
}

// Seating is an append-only event, so this never overwrites the previous
// holder — it ends their tenure by dating a new one. Returns the event id.
export async function seatPerson(input: {
  positionId: string;
  personId: string;
  effectiveFrom?: string;
}): Promise<number> {
  if (!input.positionId) throw new Error("position required");
  if (!input.personId) throw new Error("person required");
  const { data, error } = await supabase().rpc("org_seat_person", {
    p_position_id: input.positionId,
    p_person_id: input.personId,
    p_effective_from: input.effectiveFrom ?? new Date().toISOString(),
  });
  if (error) throw error;
  return data as number;
}

// The same event with no person: the seat stands empty from that moment, and
// the history of who held it before is untouched.
export async function vacatePosition(positionId: string, effectiveFrom?: string): Promise<number> {
  if (!positionId) throw new Error("position required");
  const { data, error } = await supabase().rpc("org_seat_person", {
    p_position_id: positionId,
    p_person_id: null,
    p_effective_from: effectiveFrom ?? new Date().toISOString(),
  });
  if (error) throw error;
  return data as number;
}

// Moving the seat moves its holder with it — same permanent employee code,
// same history. The database requires appointment reach over both the old and
// the new node, and refuses your own seat.
export async function movePosition(input: {
  positionId: string;
  newNodeId: string;
  newReportsToPositionId: string | null;
}): Promise<void> {
  if (!input.positionId) throw new Error("position required");
  if (!input.newNodeId) throw new Error("destination node required");
  const { error } = await supabase().rpc("org_move_position", {
    p_position_id: input.positionId,
    p_new_node_id: input.newNodeId,
    p_new_reports_to_position_id: input.newReportsToPositionId,
  });
  if (error) throw error;
}
