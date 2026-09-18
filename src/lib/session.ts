import { supabase } from "./supabaseClient";

export type CameraFunction = "provisioning" | "counting" | "compliance" | "overview";
export type HumanRole = "pending" | "viewer" | "supervisor" | "manager" | "owner";

export interface Profile {
  id: string;
  tenant_id: string;
  kind: "device" | "human";
  role: HumanRole;
  display_name: string;
}

export interface DeviceConfig {
  id: string;
  tenant_id: string;
  name: string;
  revoked_at: string | null;
}

// Identity only. What this camera does and where it stands is the owner's to
// set, so it is read from the same devices row by loadAssignment and snapshotted
// onto the session server-side - never chosen here, and never held twice.
export async function loadDeviceConfig(profileId: string): Promise<DeviceConfig | null> {
  const { data, error } = await supabase()
    .from("devices")
    .select("id, tenant_id, name, revoked_at")
    .eq("id", profileId)
    .maybeSingle();
  if (error) throw error;
  return (data as DeviceConfig | null) ?? null;
}

export async function loadProfile(): Promise<Profile | null> {
  const { data: auth } = await supabase().auth.getUser();
  if (!auth.user) return null;
  const { data, error } = await supabase()
    .from("profiles")
    .select("id, tenant_id, kind, role, display_name")
    .eq("id", auth.user.id)
    .maybeSingle();
  if (error) throw error;
  return (data as Profile | null) ?? null;
}

export type DoorRole = "check_in" | "check_out";

export interface DoorCamera {
  id: string;
  org_node_id: string;
  name: string;
  role: DoorRole;
  attendance_config: unknown;
  revoked_at: string | null;
}

function isDoorRole(role: string): role is DoorRole {
  return role === "check_in" || role === "check_out";
}

// Identity only, same shape as loadDeviceConfig above but for the org camera
// stack: what this door does is the owner's to set, read from camera_devices
// and never chosen here (rule 1 -- the phone reads nothing about people back).
export async function loadDoorCamera(profileId: string): Promise<DoorCamera | null> {
  const { data, error } = await supabase()
    .from("camera_devices")
    .select("id, org_node_id, name, role, attendance_config, revoked_at")
    .eq("id", profileId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as { role: string } & Omit<DoorCamera, "role">;
  if (!isDoorRole(row.role)) return null;
  return { ...row, role: row.role };
}
