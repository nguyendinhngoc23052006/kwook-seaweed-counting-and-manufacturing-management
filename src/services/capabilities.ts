import { supabase } from "../lib/supabaseClient";
import type { CameraCapabilityKey, CapabilityReach } from "../types/camera";

// Which nodes each capability the caller holds actually reaches. This is UX
// only -- it decides which buttons exist, never whether a write succeeds --
// and it asks the same functions the RLS policies call, so the two agree.
//
// Scoped to just the two camera capability keys for now: this repo has no
// org-tree browsing UI yet, so nothing else needs a reach query.
const REACH_QUERIES: { key: CameraCapabilityKey; strict: boolean }[] = [
  { key: "manage_camera_devices", strict: false },
  { key: "view_camera_data", strict: false },
];

export async function getMyCapabilityReach(): Promise<CapabilityReach> {
  const client = supabase();
  const [admin, person] = await Promise.all([
    client.rpc("org_admin"),
    client.rpc("org_current_person_id"),
  ]);
  if (admin.error) throw admin.error;
  if (person.error) throw person.error;
  const personId = typeof person.data === "string" ? person.data : null;

  // An admin reaches every node, and capabilityReaches() below checks isAdmin
  // before it ever reads byKey. Asking the reach queries anyway walks the
  // whole tree per navigation and discards the answer -- and the sysadmin is
  // the only person who can be signed in at all right now.
  if (admin.data === true) return { personId, isAdmin: true, byKey: {} };

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

  return { personId, isAdmin: false, byKey };
}

// The bootstrap pair -- the sysadmin and whoever holds the root seat --
// reaches everything; everyone else reaches exactly the nodes their grants
// name.
export function capabilityReaches(
  reach: CapabilityReach | undefined,
  key: CameraCapabilityKey,
  nodeId: string,
): boolean {
  if (!reach) return false;
  return reach.isAdmin || (reach.byKey[key] ?? []).includes(nodeId);
}
