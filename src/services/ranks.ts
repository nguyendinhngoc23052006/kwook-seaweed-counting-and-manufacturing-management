import { supabase } from "../lib/supabaseClient";

// A rank is a rung, and the ladder is meant to grow: org_foundation.sql's seed
// says so in as many words ("somebody has used the documented workflow to
// insert their own rank at a seeded ordinal under a different key"), and
// ranks_admin_insert / ranks_admin_update have existed since that file. What
// was missing was any way to reach them -- the app could only ever read the
// five seeded rungs.
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

// Lower ordinal = more senior. Gaps of 1000 between the seeded rungs are the
// room a new rank slots into without renumbering the ones around it, which is
// what lets the hierarchy grow forever: `ordinal` is the only thing that
// orders seniority, and a seat's rank is an id, so inserting a rung never
// rewrites a row that already exists.
export async function listRanks(): Promise<Rank[]> {
  const { data, error } = await supabase()
    .from("ranks")
    .select("*")
    .eq("active", true)
    .order("ordinal");
  if (error) throw error;
  return (data ?? []) as Rank[];
}

// Retired rungs included: a seat created years ago can still carry one, so the
// management screen has to be able to show and name it.
export async function listAllRanks(): Promise<Rank[]> {
  const { data, error } = await supabase().from("ranks").select("*").order("ordinal");
  if (error) throw error;
  return (data ?? []) as Rank[];
}

// The caller picks the two neighbours it should sit between and the midpoint
// is derived, so a human never types an ordinal. Two rungs 1 apart leave no
// midpoint, which the database's unique(ordinal) would reject anyway -- this
// says so in a sentence the caller can show instead.
export function ordinalBetween(above: number | null, below: number | null): number {
  if (above === null && below === null) return 5000;
  if (above === null) return (below as number) - 1000;
  if (below === null) return above + 1000;
  const midpoint = Math.round((above + below) / 2);
  if (midpoint <= above || midpoint >= below) {
    throw new Error("no room between those two ranks");
  }
  return midpoint;
}

export async function createRank(input: {
  key: string;
  nameVi: string;
  nameEn?: string | null;
  ordinal: number;
}): Promise<Rank> {
  const key = input.key.trim().toLowerCase();
  const nameVi = input.nameVi.trim();
  if (!key) throw new Error("rank key required");
  if (!nameVi) throw new Error("rank name required");
  if (!Number.isFinite(input.ordinal)) throw new Error("rank ordinal required");
  const { data, error } = await supabase()
    .from("ranks")
    .insert({
      key,
      name_vi: nameVi,
      name_en: input.nameEn?.trim() || null,
      ordinal: input.ordinal,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as Rank;
}

// The key is left out on purpose. It is the string every seeded policy and
// report compares against, and renaming it would silently detach every seat
// carrying it -- the same trap CLAUDE.md's naming rule describes for roles.
// A rung is renamed by its labels and retired by `active`, never re-keyed.
export async function updateRank(
  id: string,
  patch: { nameVi?: string; nameEn?: string | null; ordinal?: number; active?: boolean },
): Promise<Rank> {
  if (!id) throw new Error("rank required");
  const row: Record<string, string | number | boolean | null> = {};
  if (patch.nameVi !== undefined) row.name_vi = patch.nameVi.trim();
  if (patch.nameEn !== undefined) row.name_en = patch.nameEn?.trim() || null;
  if (patch.ordinal !== undefined) row.ordinal = patch.ordinal;
  if (patch.active !== undefined) row.active = patch.active;
  if (Object.keys(row).length === 0) throw new Error("nothing to change");

  const { data, error } = await supabase()
    .from("ranks")
    .update(row)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return data as Rank;
}
