import { supabase } from "../lib/supabaseClient";
import type { Person, PersonProfilePatch } from "./people";
import type { Position, Rank } from "./positions";

// Local type definitions: this repo has no generated src/types/database.ts.
// Named to match the source repo's export names (getMyProfile, updateMyProfile)
// so sibling ported files that import by name still resolve.
//
// Kwook Management Hub's ProfilePage/profiles.ts (source repo, since renamed from
// Mau Heritage) read and wrote a flat `profiles` row
// (display_name, phone, locale) under a five-tier set_role() hierarchy. Kwook
// has neither: no `profiles` table, no set_role(), no tiers -- a person's
// authority here is the seat they hold (services/positions.ts) plus whatever
// capabilities are granted to that seat's node (services/capabilities.ts).
// "My profile" is therefore composed from the three read-only self-info RPCs
// org_foundation.sql actually exposes: org_current_person_id() (who am I),
// org_positions_held_by() (which seats do I hold right now) and org_admin()
// (am I the sysadmin or the CEO). There is nothing to grant here -- only to
// read and, for contact details, to edit.

export interface MyOrgNode {
  id: string;
  name: string;
  name_en: string | null;
}

export interface MyPosition {
  position: Position;
  rank: Rank;
  node: MyOrgNode;
}

export interface MyProfile {
  // null for a signed-in account with no persons row of its own -- the
  // sysadmin seeded by org_foundation.sql (12.2) is exactly this case: a
  // login with company-wide admin reach but no employee record.
  person: Person | null;
  positions: MyPosition[];
  isAdmin: boolean;
}

export async function getMyProfile(): Promise<MyProfile> {
  const client = supabase();

  const [personIdResult, adminResult] = await Promise.all([
    client.rpc("org_current_person_id"),
    client.rpc("org_admin"),
  ]);
  if (personIdResult.error) throw personIdResult.error;
  if (adminResult.error) throw adminResult.error;

  const personId = typeof personIdResult.data === "string" ? personIdResult.data : null;
  const isAdmin = adminResult.data === true;

  if (!personId) {
    return { person: null, positions: [], isAdmin };
  }

  const { data: personRow, error: personError } = await client
    .from("persons")
    .select("*")
    .eq("id", personId)
    .maybeSingle();
  if (personError) throw personError;

  const { data: positionIds, error: positionIdsError } = await client.rpc("org_positions_held_by", {
    p_person: personId,
  });
  if (positionIdsError) throw positionIdsError;
  const ids = Array.isArray(positionIds) ? (positionIds as string[]) : [];

  const positions = ids.length > 0 ? await loadMyPositions(ids) : [];

  return {
    person: (personRow as Person | null) ?? null,
    positions,
    isAdmin,
  };
}

// Joins the seat rows to their rank and node so the page can render "Ca truong
// -- To may 1 -- Nhan vien chinh" without a second round trip per position. A
// position whose rank or node the caller cannot resolve is dropped rather than
// rendered half-empty -- it cannot happen under the current grants (ranks and
// org_nodes are select-able by every signed-in account) but a silent drop is
// the safer failure than a crash if that ever narrows.
async function loadMyPositions(positionIds: string[]): Promise<MyPosition[]> {
  const client = supabase();

  const { data: positionRows, error: positionsError } = await client
    .from("positions")
    .select("*")
    .in("id", positionIds);
  if (positionsError) throw positionsError;
  const positionsData = (positionRows ?? []) as Position[];
  if (positionsData.length === 0) return [];

  const rankIds = Array.from(new Set(positionsData.map((p) => p.rank_id)));
  const nodeIds = Array.from(new Set(positionsData.map((p) => p.node_id)));

  const [ranksResult, nodesResult] = await Promise.all([
    client.from("ranks").select("*").in("id", rankIds),
    client.from("org_nodes").select("id, name, name_en").in("id", nodeIds),
  ]);
  if (ranksResult.error) throw ranksResult.error;
  if (nodesResult.error) throw nodesResult.error;

  const ranksById = new Map(((ranksResult.data ?? []) as Rank[]).map((r) => [r.id, r] as const));
  const nodesById = new Map(
    ((nodesResult.data ?? []) as MyOrgNode[]).map((n) => [n.id, n] as const),
  );

  return positionsData
    .map((position): MyPosition | null => {
      const rank = ranksById.get(position.rank_id);
      const node = nodesById.get(position.node_id);
      if (!rank || !node) return null;
      return { position, rank, node };
    })
    .filter((entry): entry is MyPosition => entry !== null);
}

// Contact fields only -- the same two Kwook Management Hub's ProfilePage let a person
// edit about themselves (display_name, phone). full_name, employee_code and
// status stay manager/admin-controlled through services/people.ts; locale has
// no server column here (see ProfilePage.tsx) so it never appears in a patch.
export type MyProfilePatch = Pick<PersonProfilePatch, "display_name" | "phone">;

export async function updateMyProfile(patch: MyProfilePatch): Promise<Person> {
  const client = supabase();
  const { data: personId, error: personIdError } = await client.rpc("org_current_person_id");
  if (personIdError) throw personIdError;
  if (typeof personId !== "string") {
    throw new Error("no person record for this account");
  }

  const { data, error } = await client
    .from("persons")
    .update(patch)
    .eq("id", personId)
    .select("*")
    .single();
  if (error) throw error;
  return data as Person;
}
