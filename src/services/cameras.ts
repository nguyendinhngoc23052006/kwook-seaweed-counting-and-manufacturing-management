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
    .select("*")
    .eq("org_node_id", nodeId)
    .order("name");
  if (error) throw error;
  return (data ?? []) as CameraStation[];
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
