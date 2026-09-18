// Pure decision logic for the check-in / check-out camera. No DOM, no
// TensorFlow, no network -- so the rules a phone applies to a face box can be
// tested without a camera, the same way src/vision is.

// Bumped whenever the nets or the pre-processing in faceEngine.ts change: an
// embedding made by one version is not comparable to one made by another, so
// both the enrolment row and every capture carry it (CLAUDE.md rule 3, applied
// to faces instead of leaf counts). It lives here, not in faceEngine.ts, so the
// org hub can tell a stale enrolment apart without downloading TensorFlow.
export const FACE_MODEL_VERSION = "face-api@1.7.15/tiny-fd+lm68tiny+fr";

export interface FaceBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Fractions of the frame, so one zone works at any resolution.
export interface Zone {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type CameraFacing = "user" | "environment";

export interface AttendanceConfig {
  zone: Zone;
  // A face must span at least this fraction of the frame width to count as
  // "close to the camera" -- someone walking past behind the zone stays too
  // small to trigger anything.
  minFaceRatio: number;
  // Consecutive frames the same candidate must hold before a capture fires.
  stableFrames: number;
  // face-api descriptor distance; the server applies it, the phone only shows it.
  matchThreshold: number;
  // The same person is logged at most once per this many seconds on one device.
  cooldownSeconds: number;
  flashMs: number;
  facing: CameraFacing;
}

export const DEFAULT_ATTENDANCE_CONFIG: AttendanceConfig = {
  zone: { x: 0.2, y: 0.1, w: 0.6, h: 0.8 },
  minFaceRatio: 0.22,
  stableFrames: 4,
  matchThreshold: 0.6,
  cooldownSeconds: 120,
  flashMs: 350,
  facing: "user",
};

function num(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

// The device row's attendance_config is free jsonb written through a guarded
// RPC; this is still the client-side boundary, so every field is clamped to a
// sane range and anything missing falls back to the default.
export function parseAttendanceConfig(raw: unknown): AttendanceConfig {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const zoneRaw =
    source.zone && typeof source.zone === "object" ? (source.zone as Record<string, unknown>) : {};
  const d = DEFAULT_ATTENDANCE_CONFIG;
  const x = num(zoneRaw.x, d.zone.x, 0, 1);
  const y = num(zoneRaw.y, d.zone.y, 0, 1);
  return {
    zone: {
      x,
      y,
      w: num(zoneRaw.w, d.zone.w, 0.05, 1 - x),
      h: num(zoneRaw.h, d.zone.h, 0.05, 1 - y),
    },
    minFaceRatio: num(source.min_face_ratio, d.minFaceRatio, 0.05, 1),
    stableFrames: Math.round(num(source.stable_frames, d.stableFrames, 1, 30)),
    matchThreshold: num(source.match_threshold, d.matchThreshold, 0.1, 1.5),
    cooldownSeconds: Math.round(num(source.cooldown_seconds, d.cooldownSeconds, 0, 86400)),
    flashMs: Math.round(num(source.flash_ms, d.flashMs, 0, 3000)),
    facing: source.facing === "environment" ? "environment" : "user",
  };
}

export function largestFace(faces: FaceBox[]): FaceBox | null {
  let best: FaceBox | null = null;
  for (const face of faces) {
    if (!best || face.width * face.height > best.width * best.height) best = face;
  }
  return best;
}

export function faceInZone(
  box: FaceBox,
  frameWidth: number,
  frameHeight: number,
  zone: Zone,
): boolean {
  if (frameWidth <= 0 || frameHeight <= 0) return false;
  const cx = (box.x + box.width / 2) / frameWidth;
  const cy = (box.y + box.height / 2) / frameHeight;
  return cx >= zone.x && cx <= zone.x + zone.w && cy >= zone.y && cy <= zone.y + zone.h;
}

export function faceCloseEnough(box: FaceBox, frameWidth: number, minFaceRatio: number): boolean {
  if (frameWidth <= 0) return false;
  return box.width / frameWidth >= minFaceRatio;
}

export function isCaptureCandidate(
  box: FaceBox,
  frameWidth: number,
  frameHeight: number,
  config: AttendanceConfig,
): boolean {
  return (
    faceInZone(box, frameWidth, frameHeight, config.zone) &&
    faceCloseEnough(box, frameWidth, config.minFaceRatio)
  );
}

// Counts consecutive candidate frames; fires once when the run reaches the
// required length and then stays quiet until reset, so a person standing
// still is captured once, not every frame.
export class StabilityGate {
  private run = 0;
  private fired = false;

  constructor(private readonly needed: number) {}

  update(candidate: boolean): boolean {
    if (!candidate) {
      this.run = 0;
      this.fired = false;
      return false;
    }
    this.run += 1;
    if (this.fired || this.run < this.needed) return false;
    this.fired = true;
    return true;
  }

  reset(): void {
    this.run = 0;
    this.fired = false;
  }
}
