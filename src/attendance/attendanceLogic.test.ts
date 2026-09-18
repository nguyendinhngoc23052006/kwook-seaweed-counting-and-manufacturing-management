import { describe, expect, it } from "vitest";
import {
  DEFAULT_ATTENDANCE_CONFIG,
  faceCloseEnough,
  faceInZone,
  isCaptureCandidate,
  largestFace,
  parseAttendanceConfig,
  StabilityGate,
} from "./attendanceLogic";

const frame = { w: 640, h: 480 };

describe("parseAttendanceConfig", () => {
  it("returns defaults for empty or malformed input", () => {
    expect(parseAttendanceConfig({})).toEqual(DEFAULT_ATTENDANCE_CONFIG);
    expect(parseAttendanceConfig(null)).toEqual(DEFAULT_ATTENDANCE_CONFIG);
    expect(parseAttendanceConfig("nope")).toEqual(DEFAULT_ATTENDANCE_CONFIG);
  });

  it("reads the server's snake_case keys and clamps them", () => {
    const cfg = parseAttendanceConfig({
      zone: { x: 0.5, y: 0.5, w: 5, h: -1 },
      min_face_ratio: 2,
      stable_frames: 100,
      match_threshold: 0,
      cooldown_seconds: -5,
      flash_ms: 99999,
      facing: "environment",
    });
    expect(cfg.zone).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.05 });
    expect(cfg.minFaceRatio).toBe(1);
    expect(cfg.stableFrames).toBe(30);
    expect(cfg.matchThreshold).toBe(0.1);
    expect(cfg.cooldownSeconds).toBe(0);
    expect(cfg.flashMs).toBe(3000);
    expect(cfg.facing).toBe("environment");
  });

  it("clamps match_threshold to the server's 0.8 ceiling", () => {
    const cfg = parseAttendanceConfig({ match_threshold: 9 });
    expect(cfg.matchThreshold).toBe(0.8);
  });

  it("never lets the zone run past the frame edge", () => {
    const cfg = parseAttendanceConfig({ zone: { x: 0.9, y: 0.9, w: 0.5, h: 0.5 } });
    expect(cfg.zone.x + cfg.zone.w).toBeLessThanOrEqual(1);
    expect(cfg.zone.y + cfg.zone.h).toBeLessThanOrEqual(1);
  });
});

describe("largestFace", () => {
  it("picks the biggest box and null for none", () => {
    expect(largestFace([])).toBeNull();
    const small = { x: 0, y: 0, width: 10, height: 10 };
    const big = { x: 50, y: 50, width: 100, height: 120 };
    expect(largestFace([small, big, small])).toBe(big);
  });
});

describe("faceInZone / faceCloseEnough", () => {
  const zone = DEFAULT_ATTENDANCE_CONFIG.zone; // x 0.2..0.8, y 0.1..0.9

  it("uses the box centre, in frame fractions", () => {
    const centred = { x: 270, y: 190, width: 100, height: 100 }; // centre (0.5, 0.5)
    expect(faceInZone(centred, frame.w, frame.h, zone)).toBe(true);
    const edge = { x: 0, y: 0, width: 40, height: 40 }; // centre (0.03, 0.04)
    expect(faceInZone(edge, frame.w, frame.h, zone)).toBe(false);
  });

  it("treats a face spanning less than the ratio as too far away", () => {
    const far = { x: 300, y: 200, width: 60, height: 60 }; // 60/640 = 0.09
    const near = { x: 200, y: 100, width: 200, height: 220 }; // 0.31
    expect(faceCloseEnough(far, frame.w, 0.22)).toBe(false);
    expect(faceCloseEnough(near, frame.w, 0.22)).toBe(true);
  });

  it("isCaptureCandidate needs both", () => {
    const nearButOutside = { x: 0, y: 0, width: 200, height: 200 }; // centre (0.16, 0.21)
    const insideButFar = { x: 300, y: 220, width: 40, height: 40 };
    const good = { x: 220, y: 130, width: 200, height: 220 };
    expect(isCaptureCandidate(nearButOutside, frame.w, frame.h, DEFAULT_ATTENDANCE_CONFIG)).toBe(
      false,
    );
    expect(isCaptureCandidate(insideButFar, frame.w, frame.h, DEFAULT_ATTENDANCE_CONFIG)).toBe(
      false,
    );
    expect(isCaptureCandidate(good, frame.w, frame.h, DEFAULT_ATTENDANCE_CONFIG)).toBe(true);
  });

  it("rejects a zero-sized frame rather than dividing by zero", () => {
    const box = { x: 0, y: 0, width: 10, height: 10 };
    expect(faceInZone(box, 0, 0, zone)).toBe(false);
    expect(faceCloseEnough(box, 0, 0.2)).toBe(false);
  });
});

describe("StabilityGate", () => {
  it("fires once after N consecutive candidate frames, then stays quiet", () => {
    const gate = new StabilityGate(3);
    expect(gate.update(true)).toBe(false);
    expect(gate.update(true)).toBe(false);
    expect(gate.update(true)).toBe(true);
    expect(gate.update(true)).toBe(false);
    expect(gate.update(true)).toBe(false);
  });

  it("a single miss restarts the run", () => {
    const gate = new StabilityGate(2);
    expect(gate.update(true)).toBe(false);
    expect(gate.update(false)).toBe(false);
    expect(gate.update(true)).toBe(false);
    expect(gate.update(true)).toBe(true);
  });

  it("reset re-arms it for the next person", () => {
    const gate = new StabilityGate(1);
    expect(gate.update(true)).toBe(true);
    expect(gate.update(true)).toBe(false);
    gate.reset();
    expect(gate.update(true)).toBe(true);
  });
});
