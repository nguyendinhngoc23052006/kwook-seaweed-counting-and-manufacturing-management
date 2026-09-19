import { supabase } from "../lib/supabaseClient";
import type {
  CameraDevice,
  CameraDeviceRole,
  CameraStation,
  CreatedCameraDevice,
} from "../types/camera";

// Human admin side: list/create/revoke. Reads are plain RLS-gated selects
// (org_admin() or a granted capability); creating a device needs a real
// Supabase Auth account, which only the Edge Function's service role can do.

export async function listCameraDevices(nodeId: string): Promise<CameraDevice[]> {
  const client = supabase();
  const { data, error } = await client
    .from("camera_devices")
    .select("*")
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

export async function createCameraDevice(input: {
  nodeId: string;
  name: string;
  role: CameraDeviceRole;
  stationId?: string | null;
}): Promise<CreatedCameraDevice> {
  const client = supabase();
  const { data, error } = await client.functions.invoke("create-camera-device", {
    body: {
      nodeId: input.nodeId,
      name: input.name,
      role: input.role,
      stationId: input.stationId ?? null,
    },
  });
  if (error) throw error;
  return data as CreatedCameraDevice;
}

export async function revokeCameraDevice(deviceId: string): Promise<void> {
  const client = supabase();
  const { error } = await client.rpc("org_camera_revoke_device", {
    p_device_id: deviceId,
  });
  if (error) throw error;
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
