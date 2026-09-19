import { supabase } from "../lib/supabaseClient";

// A camera is a stretch of recording, not a permanent fixture. The open session
// row is the ONLY statement of what a phone is doing now - but WHERE it is and
// WHAT it does are the owner's to decide, held on the devices row and copied
// onto the session by the server (migration 20260917092000). No open session
// means the camera is off the line in that instant, not ageing towards stale.
export interface CaptureSession {
  id: string;
  device_id: string;
  station_id: string | null;
  camera_function: string;
  // Frozen words, not lookups: what the line, the station and the phone were
  // CALLED while this session ran, so a report about last March still reads the
  // same after everything is renamed. Null on sessions started before the
  // snapshot existed.
  line_name: string | null;
  station_name: string | null;
  device_label: string | null;
  started_at: string;
  ended_at: string | null;
  end_reason: string | null;
  // The last instant this camera proved it was recording. The reaper closes a
  // vanished session at this time, never at now().
  last_evidence_at: string | null;
}

// 'lost' is deliberately absent: it is the reaper's word for a camera that
// vanished, and a client saying it would be claiming an end it did not witness.
export type EndReason = "signed_out" | "stopped" | "revoked" | "ended_by_owner";

// The owner's assignment as the camera reads it - never as the camera chooses
// it. This is display material; the session's own snapshot is the record.
export interface DeviceAssignment {
  lineName: string | null;
  stationId: string | null;
  stationName: string | null;
  cameraFunction: string;
}

// algorithm_version is stored but not returned: it is provenance for the rows a
// session produces, not something a screen renders.
const SESSION_COLUMNS =
  "id, device_id, station_id, camera_function, line_name, station_name, device_label, started_at, ended_at, end_reason, last_evidence_at";

// Placement is not sent. The before-insert trigger overwrites station_id and
// camera_function from this device's own row, so a phone that named them would
// be stating a fact it is not the author of - and the name columns it cannot
// write at all.
//
// Nor is a leftover open session closed here. It used to be, with the phone's
// own clock: a tab killed at 09:00 and restarted at 17:00 was recorded as
// having counted for eight hours it spent in someone's pocket. A session the
// camera did not stop is closed by the reaper at its last evidence instead; a
// session this same phone still holds is RESUMED (loadOpenSession), not
// restarted, which is why the one-open-per-device index rejecting this insert
// is the correct answer rather than a problem to clear out of the way.
export async function startSession(input: {
  deviceId: string;
  algorithmVersion: string;
}): Promise<CaptureSession> {
  const { data, error } = await supabase()
    .from("capture_sessions")
    .insert({
      device_id: input.deviceId,
      algorithm_version: input.algorithmVersion,
    })
    .select(SESSION_COLUMNS)
    .single();
  if (error) throw error;
  return data as CaptureSession;
}

// now() is honest here and only here: something happening in this instant - a
// stop button, a sign-out, an owner ending it - is what ends the session.
//
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

// What this camera has been assigned, read one table at a time.
//
// lineName comes back null for a device: `lines` has no device read policy
// (migration 20260917091000, deliberately - a camera does not get to list the
// factory), so the query returns no row rather than an error. A camera learns
// its line from the line_name its own session carries; an owner's screen, which
// may read lines, gets the name here.
export async function loadAssignment(deviceId: string): Promise<DeviceAssignment> {
  const { data, error } = await supabase()
    .from("devices")
    .select("camera_function, station_id")
    .eq("id", deviceId)
    .single();
  if (error) throw error;
  const device = data as { camera_function: string; station_id: string | null };
  const assignment: DeviceAssignment = {
    lineName: null,
    stationId: device.station_id,
    stationName: null,
    cameraFunction: device.camera_function,
  };
  if (!assignment.stationId) return assignment;

  const { data: stationRow, error: stationError } = await supabase()
    .from("stations")
    .select("name, line_id")
    .eq("id", assignment.stationId)
    .maybeSingle();
  if (stationError) throw stationError;
  const station = stationRow as { name: string; line_id: string | null } | null;
  if (!station) return assignment;
  assignment.stationName = station.name;
  if (!station.line_id) return assignment;

  const { data: lineRow, error: lineError } = await supabase()
    .from("lines")
    .select("name")
    .eq("id", station.line_id)
    .maybeSingle();
  if (lineError) throw lineError;
  assignment.lineName = (lineRow as { name: string } | null)?.name ?? null;
  return assignment;
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

// Unfiltered on purpose: RLS scopes this to what the caller may see,
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
