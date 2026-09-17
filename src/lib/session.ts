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
