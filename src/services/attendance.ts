import { supabase } from "../lib/supabaseClient";

// Check-in / check-out cameras and the hours report. Rule 1: the phone is
// write-only -- captureAttendance and sendAttendanceHeartbeat never read a
// person, a photo or an embedding back, only a status.

export interface AttendanceConfigJson {
  zone?: { x: number; y: number; w: number; h: number };
  min_face_ratio?: number;
  stable_frames?: number;
  match_threshold?: number;
  cooldown_seconds?: number;
  flash_ms?: number;
  facing?: "user" | "environment";
}

export type CaptureStatus = "matched" | "cooldown" | "no_match";

export interface CaptureResult {
  status: CaptureStatus;
  kind: "check_in" | "check_out";
  person_name?: string;
  distance: number | null;
  captured_at?: string;
  last_at?: string;
}

function isFiniteNumberArray(value: unknown, length: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

export async function captureAttendance(input: {
  embedding: number[];
  capturedAt: string;
  modelVersion: string;
}): Promise<CaptureResult> {
  if (!isFiniteNumberArray(input.embedding, 128)) {
    throw new Error("an embedding is 128 numbers");
  }
  const { data, error } = await supabase().rpc("camera_attendance_capture", {
    p_embedding: input.embedding,
    p_captured_at: input.capturedAt,
    p_model_version: input.modelVersion,
  });
  if (error) throw error;
  return data as CaptureResult;
}

export async function sendAttendanceHeartbeat(input: {
  deviceId: string;
  nodeId: string;
  mode: "check_in" | "check_out";
}): Promise<void> {
  const { error } = await supabase()
    .from("camera_device_heartbeats")
    .insert({ org_node_id: input.nodeId, device_id: input.deviceId, mode: input.mode });
  if (error) throw error;
}

export interface FaceEnrollment {
  enrolled_at: string;
  model_version: string;
  photo_path: string;
}

export async function getFaceEnrollment(personId: string): Promise<FaceEnrollment | null> {
  const { data, error } = await supabase().rpc("org_face_enrollment", {
    p_person_id: personId,
  });
  if (error) throw error;
  return (data as FaceEnrollment | null) ?? null;
}

export async function uploadPersonPhoto(personId: string, file: Blob): Promise<string> {
  const path = `${personId}/${crypto.randomUUID()}.jpg`;
  const { error } = await supabase()
    .storage.from("person-photos")
    .upload(path, file, { contentType: "image/jpeg", upsert: false });
  if (error) throw error;
  return path;
}

export async function getPersonPhotoUrl(path: string): Promise<string> {
  const { data, error } = await supabase()
    .storage.from("person-photos")
    .createSignedUrl(path, 3600);
  if (error) throw error;
  return data.signedUrl;
}

export async function enrollFace(input: {
  personId: string;
  embedding: number[];
  modelVersion: string;
  photoPath: string;
}): Promise<void> {
  if (!isFiniteNumberArray(input.embedding, 128)) {
    throw new Error("an embedding is 128 numbers");
  }
  const { error } = await supabase().rpc("org_enroll_face", {
    p_person_id: input.personId,
    p_embedding: input.embedding,
    p_model_version: input.modelVersion,
    p_photo_path: input.photoPath,
  });
  if (error) throw error;
}

export async function setAttendanceConfig(
  deviceId: string,
  config: AttendanceConfigJson,
): Promise<void> {
  const { error } = await supabase().rpc("org_camera_set_attendance_config", {
    p_device_id: deviceId,
    p_config: config,
  });
  if (error) throw error;
}

export interface AttendanceRow {
  person_id: string;
  full_name: string;
  employee_code: string;
  day: string;
  first_in: string | null;
  last_out: string | null;
  seconds_on_site: number;
  check_ins: number;
  check_outs: number;
  unpaired_ins: number;
  unpaired_outs: number;
}

export async function fetchAttendanceReport(
  nodeId: string,
  sinceIso: string,
  untilIso: string,
): Promise<AttendanceRow[]> {
  const { data, error } = await supabase().rpc("org_attendance_report", {
    p_node: nodeId,
    p_since: sinceIso,
    p_until: untilIso,
  });
  if (error) throw error;
  return (data ?? []) as AttendanceRow[];
}

export async function exportAttendance(
  nodeId: string,
  sinceIso: string,
  untilIso: string,
): Promise<AttendanceRow[]> {
  const { data, error } = await supabase().rpc("org_attendance_export", {
    p_node: nodeId,
    p_since: sinceIso,
    p_until: untilIso,
  });
  if (error) throw error;
  return (data ?? []) as AttendanceRow[];
}

const CSV_HEADER = [
  "person_id",
  "full_name",
  "employee_code",
  "day",
  "first_in",
  "last_out",
  "hours_on_site",
  "check_ins",
  "check_outs",
  "unpaired_ins",
  "unpaired_outs",
];

function csvField(value: string | number): string {
  const text = String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function attendanceRowsToCsv(rows: AttendanceRow[]): string {
  const lines = [CSV_HEADER.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.person_id,
        row.full_name,
        row.employee_code,
        row.day,
        row.first_in ?? "",
        row.last_out ?? "",
        (row.seconds_on_site / 3600).toFixed(2),
        row.check_ins,
        row.check_outs,
        row.unpaired_ins,
        row.unpaired_outs,
      ]
        .map(csvField)
        .join(","),
    );
  }
  // BOM first so Excel reads Vietnamese names as UTF-8 instead of mojibake.
  return `﻿${lines.join("\r\n")}`;
}
