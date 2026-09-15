import { supabase } from "./supabaseClient";

export type DeviceRole = "provisioning" | "counting" | "compliance" | "overview";
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
  role: DeviceRole;
  station_id: string | null;
  revoked_at: string | null;
}

// The device's role comes from its own row, never from the URL. A device that
// could name its own role could name a different one.
export async function loadDeviceConfig(profileId: string): Promise<DeviceConfig | null> {
  const { data, error } = await supabase()
    .from("devices")
    .select("id, tenant_id, name, role, station_id, revoked_at")
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
