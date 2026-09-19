import { supabase } from "../lib/supabaseClient";
import type { CameraDevice, CameraDeviceRole, CameraStation } from "../types/camera";

// Human admin side: list/claim/revoke. Reads are plain RLS-gated selects
// (org_admin() or a granted capability); bringing a camera into existence needs
// a real Supabase Auth account, which only the Edge Function's service role
// can do -- and it is always a CLAIM of a QR the phone is already showing.

export async function listCameraDevices(nodeId: string): Promise<CameraDevice[]> {
  const client = supabase();
  const { data, error } = await client
    .from("camera_devices")
    .select("*")
    // RLS lets the sysadmin and the CEO see archived cameras, so the live list
    // has to say it does not want them -- otherwise an admin's Cameras page
    // quietly fills up with everything anyone ever hid.
    .is("archived_at", null)
    .eq("org_node_id", nodeId)
    .order("name");
  if (error) throw error;
  return (data ?? []) as CameraDevice[];
}

export async function listCameraStations(nodeId: string): Promise<CameraStation[]> {
  const client = supabase();
  const { data, error } = await client
    .from("camera_stations")
    .select("*, camera_lines(name)")
    .eq("org_node_id", nodeId)
    .order("name");
  if (error) throw error;
  const rows = (data ?? []) as (Omit<CameraStation, "line_name"> & {
    camera_lines: { name: string } | null;
  })[];
  return rows.map(({ camera_lines, ...station }) => ({
    ...station,
    line_name: camera_lines?.name ?? "",
  }));
}

// A line exists because someone named it. Resolving here rather than making the
// admin pick from a list first keeps the station form one screen: they type the
// line, and the same words always land on the same row.
async function lineIdFor(nodeId: string, name: string): Promise<string> {
  const line = name.trim();
  if (!line) throw new Error("line required");
  const { data, error } = await supabase().rpc("org_camera_line_id", {
    p_node_id: nodeId,
    p_name: line,
  });
  if (error) throw error;
  return data as string;
}

// A camera is CLAIMED, never issued credentials. The phone invents a secret
// and shows it as a QR; this hands that code to the server along with the node
// the claimer is standing in, and the server mints the device's account and a
// one-time login token the waiting phone redeems itself. Nobody ever sees a
// password, which is the constitution's rule, not a preference.
//
// The Edge Function is the one privileged step -- creating an auth account
// needs the Admin API -- and it verifies the CALLER's authority at this node
// with the caller's own token before it touches the service role.
export async function claimCameraPairing(input: {
  nodeId: string;
  name: string;
  role: CameraDeviceRole;
  code: string;
  stationId?: string | null;
}): Promise<void> {
  const name = input.name.trim();
  const code = input.code.trim();
  if (!name) throw new Error("camera name required");
  if (!code) throw new Error("pairing code required");
  const { data, error } = await supabase().functions.invoke("pair-claim", {
    body: {
      code,
      name,
      role: input.role,
      node_id: input.nodeId,
      station_id: input.stationId ?? null,
    },
  });
  // functions.invoke throws on a non-2xx and hides our JSON body behind a
  // generic message; dig the real reason out of the Response it stashes on
  // error.context so the claimer sees what actually failed.
  if (error) {
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) {
      const body = await context.json().catch(() => null);
      if (body && typeof body === "object" && "error" in body) {
        throw new Error(String((body as { error: unknown }).error));
      }
    }
    throw error;
  }
  if (data && typeof data === "object" && "error" in data && data.error) {
    throw new Error(String((data as { error: unknown }).error));
  }
}

// Re-pairing points an EXISTING camera at whatever phone is showing the QR.
//
// A camera's identity -- its row and its auth account -- is permanent. What is
// fragile is the login the phone keeps in its own storage, which browsers evict
// and people clear. Without this, a phone that lost its login had to be paired
// afresh, minting a second camera and orphaning the first, so one physical
// camera's history arrived split across two rows that nothing joins. Same row,
// same history, new handset.
//
// The node is not passed: the server reads it from the camera's own row, so
// re-pairing can never quietly move a camera somewhere else.
export async function repairCameraPairing(input: {
  deviceId: string;
  code: string;
}): Promise<void> {
  const code = input.code.trim();
  if (!input.deviceId) throw new Error("camera required");
  if (!code) throw new Error("pairing code required");
  const { data, error } = await supabase().functions.invoke("pair-claim", {
    body: { code, device_id: input.deviceId },
  });
  if (error) {
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) {
      const body = await context.json().catch(() => null);
      if (body && typeof body === "object" && "error" in body) {
        throw new Error(String((body as { error: unknown }).error));
      }
    }
    throw error;
  }
  if (data && typeof data === "object" && "error" in data && data.error) {
    throw new Error(String((data as { error: unknown }).error));
  }
}

export async function revokeCameraDevice(deviceId: string): Promise<void> {
  const client = supabase();
  const { error } = await client.rpc("org_camera_revoke_device", {
    p_device_id: deviceId,
  });
  if (error) throw error;
}

// Removing a camera that should never have existed -- paired to the wrong
// phone, named wrong, never started. The DATABASE decides whether that is
// allowed: a camera that has recorded anything is refused and must be revoked
// instead, which stops it at once and keeps everything it measured. The refusal
// comes back as the server's own sentence, so it says which camera and why.
// "Delete" hides a camera; it never destroys one. A camera is the parent of
// everything it measured, so destroying one either takes that history with it
// or is refused -- and the button people actually want is "stop showing me
// this", which does not have to touch the data at all.
//
// Archiving implies revoking: a camera nobody can see must not still be
// writing rows. Restoring brings it back REVOKED rather than running, so
// un-hiding never silently puts a camera back to work in a doorway nobody has
// looked at since.
export async function archiveCameraDevice(deviceId: string): Promise<void> {
  if (!deviceId) throw new Error("camera required");
  const { error } = await supabase().rpc("org_camera_archive_device", {
    p_device_id: deviceId,
  });
  if (error) throw error;
}

export async function unarchiveCameraDevice(deviceId: string): Promise<void> {
  if (!deviceId) throw new Error("camera required");
  const { error } = await supabase().rpc("org_camera_unarchive_device", {
    p_device_id: deviceId,
  });
  if (error) throw error;
}

// Only the sysadmin and the CEO can read these at all -- the policy, not this
// query, is what enforces that. For everyone else it comes back empty.
export async function listArchivedCameraDevices(nodeId: string): Promise<CameraDevice[]> {
  const { data, error } = await supabase()
    .from("camera_devices")
    .select("*")
    .not("archived_at", "is", null)
    .eq("org_node_id", nodeId)
    .order("name");
  if (error) throw error;
  return (data ?? []) as CameraDevice[];
}

// Placement after pairing. Until 20260929000000 camera_devices was SELECT-only
// to every client with no write policy at all, so a camera's name, role,
// station and unit were frozen at creation and the only way to move a camera
// was to revoke it and pair a new one -- starting its attendance history over.
// CLAUDE.md rule 2 makes the owner the single placement authority; this is
// what lets them exercise it more than once.
export async function updateCameraDevice(input: {
  deviceId: string;
  name?: string;
  role?: CameraDeviceRole;
  stationId?: string | null;
  nodeId?: string;
}): Promise<void> {
  if (!input.deviceId) throw new Error("device required");
  const { error } = await supabase().rpc("org_camera_update_device", {
    p_device_id: input.deviceId,
    p_name: input.name?.trim() || null,
    p_role: input.role ?? null,
    // null means "leave it"; clearing needs its own flag, or a camera could
    // never be detached from a station once attached.
    p_station_id: input.stationId ?? null,
    p_clear_station: input.stationId === null,
    p_node_id: input.nodeId ?? null,
  });
  if (error) throw error;
}

// revoked_at was set by an RPC and cleared by nothing: a camera revoked by
// mistake was cut off permanently.
export async function restoreCameraDevice(deviceId: string): Promise<void> {
  if (!deviceId) throw new Error("device required");
  const { error } = await supabase().rpc("org_camera_restore_device", {
    p_device_id: deviceId,
  });
  if (error) throw error;
}

// Stations have had full write policies and grants since they were created and
// no service function ever used them, so a device could never be given a
// placement to point at.
export async function createCameraStation(input: {
  nodeId: string;
  name: string;
  line: string;
  kind: CameraStation["kind"];
}): Promise<CameraStation> {
  const name = input.name.trim();
  if (!name) throw new Error("station name required");
  const lineId = await lineIdFor(input.nodeId, input.line);
  const { data, error } = await supabase()
    .from("camera_stations")
    .insert({ org_node_id: input.nodeId, name, line_id: lineId, kind: input.kind })
    .select("*, camera_lines(name)")
    .single();
  if (error) throw error;
  const { camera_lines, ...station } = data as Omit<CameraStation, "line_name"> & {
    camera_lines: { name: string } | null;
  };
  return { ...station, line_name: camera_lines?.name ?? "" };
}

export async function updateCameraStation(
  stationId: string,
  patch: {
    nodeId?: string;
    name?: string;
    line?: string;
    kind?: CameraStation["kind"];
    active?: boolean;
  },
): Promise<CameraStation> {
  if (!stationId) throw new Error("station required");
  const row: Record<string, string | boolean> = {};
  if (patch.name !== undefined) row.name = patch.name.trim();
  if (patch.line !== undefined) {
    if (!patch.nodeId) throw new Error("node required to move a station to a line");
    row.line_id = await lineIdFor(patch.nodeId, patch.line);
  }
  if (patch.kind !== undefined) row.kind = patch.kind;
  if (patch.active !== undefined) row.active = patch.active;
  if (Object.keys(row).length === 0) throw new Error("nothing to change");
  const { data, error } = await supabase()
    .from("camera_stations")
    .update(row)
    .eq("id", stationId)
    .select("*, camera_lines(name)")
    .single();
  if (error) throw error;
  const { camera_lines, ...station } = data as Omit<CameraStation, "line_name"> & {
    camera_lines: { name: string } | null;
  };
  return { ...station, line_name: camera_lines?.name ?? "" };
}
