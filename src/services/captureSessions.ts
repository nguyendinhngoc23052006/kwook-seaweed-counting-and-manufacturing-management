import { supabase } from "../lib/supabaseClient";

// A camera is a stretch of recording, not a permanent fixture. The open session
// row is the ONLY statement of what a phone is doing now - devices.role and
// devices.station_id survive as the defaults a new session is pre-filled with,
// and nothing here reads them. No open session means the camera is off the line
// in that instant, not ageing towards stale.
export interface CaptureSession {
  id: string;
  tenant_id: string;
  device_id: string;
  station_id: string | null;
  camera_function: string;
  started_at: string;
  ended_at: string | null;
  end_reason: string | null;
}

export type EndReason = "signed_out" | "stopped" | "revoked" | "ended_by_owner";

// algorithm_version is stored but not returned: it is provenance for the rows a
// session produces, not something a screen renders.
const SESSION_COLUMNS =
  "id, tenant_id, device_id, station_id, camera_function, started_at, ended_at, end_reason";

export async function startSession(input: {
  tenantId: string;
  deviceId: string;
  stationId: string | null;
  cameraFunction: string;
  algorithmVersion: string;
}): Promise<CaptureSession> {
  // A tab killed mid-session leaves its row open and
  // `capture_sessions_one_open_per_device` then rejects the new insert outright.
  // Closing first lets the phone start again with no owner intervention; usually
  // it matches nothing.
  const { error: closeError } = await supabase()
    .from("capture_sessions")
    .update({ ended_at: new Date().toISOString(), end_reason: "stopped" })
    .eq("device_id", input.deviceId)
    .is("ended_at", null);
  if (closeError) throw closeError;

  const { data, error } = await supabase()
    .from("capture_sessions")
    .insert({
      tenant_id: input.tenantId,
      device_id: input.deviceId,
      station_id: input.stationId,
      camera_function: input.cameraFunction,
      algorithm_version: input.algorithmVersion,
    })
    .select(SESSION_COLUMNS)
    .single();
  if (error) throw error;
  return data as CaptureSession;
}

// Matching only rows that are still open makes this idempotent AND keeps the
// first reason: a session the revoke trigger already closed must not be
// relabelled "signed_out" by a phone that comes back to finish its shutdown.
export async function endSession(sessionId: string, reason: EndReason): Promise<void> {
  const { error } = await supabase()
    .from("capture_sessions")
    .update({ ended_at: new Date().toISOString(), end_reason: reason })
    .eq("id", sessionId)
    .is("ended_at", null);
  if (error) throw error;
}

// How a camera learns what it is doing. The partial unique index guarantees at
// most one row, so a second one is a database fault, not a case to handle.
export async function loadOpenSession(deviceId: string): Promise<CaptureSession | null> {
  const { data, error } = await supabase()
    .from("capture_sessions")
    .select(SESSION_COLUMNS)
    .eq("device_id", deviceId)
    .is("ended_at", null)
    .maybeSingle();
  if (error) throw error;
  return (data as CaptureSession | null) ?? null;
}

// Unfiltered by tenant on purpose: RLS scopes this to the caller's own tenant,
// and one device can only ever see its own row. Bounded by the paired device
// count, since a device holds at most one open session.
export async function loadOpenSessions(): Promise<CaptureSession[]> {
  const { data, error } = await supabase()
    .from("capture_sessions")
    .select(SESSION_COLUMNS)
    .is("ended_at", null)
    .order("started_at", { ascending: false });
  if (error) throw error;
  return (data as CaptureSession[] | null) ?? [];
}

export async function loadRecentSessions(
  deviceId: string,
  limit: number,
): Promise<CaptureSession[]> {
  const { data, error } = await supabase()
    .from("capture_sessions")
    .select(SESSION_COLUMNS)
    .eq("device_id", deviceId)
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as CaptureSession[] | null) ?? [];
}
