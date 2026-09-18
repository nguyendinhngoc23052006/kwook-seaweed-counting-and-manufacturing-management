import { type CSSProperties, useCallback, useEffect, useState } from "react";
import { FACE_MODEL_VERSION, parseAttendanceConfig } from "../attendance/attendanceLogic";
import { useDoorCamera } from "../attendance/useDoorCamera";
import { errorMessage } from "../lib/errorMessage";
import type { DoorCamera } from "../lib/session";
import { supabase } from "../lib/supabaseClient";
import {
  type CaptureResult,
  type CaptureStatus,
  captureAttendance,
  sendAttendanceHeartbeat,
} from "../services/attendance";

const HEARTBEAT_INTERVAL_MS = 60_000;
const NO_FACE_BANNER_MS = 3_000;
const RESULT_BORDER_MS = 2_000;
const RESULT_CARD_MS = 4_000;

const FLASH_OVERLAY_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "#fff",
  zIndex: 1000,
  pointerEvents: "none",
};

function formatLocalTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function zoneBorderColor(candidate: boolean, resultFlash: CaptureStatus | null): string {
  if (resultFlash === "matched") return "var(--ok)";
  if (resultFlash === "cooldown") return "var(--warn)";
  if (resultFlash === "no_match") return "var(--crit)";
  return candidate ? "var(--warn)" : "var(--rule)";
}

function resultHeadline(result: CaptureResult): { vi: string; en: string } {
  if (result.status === "matched") {
    return result.kind === "check_in"
      ? { vi: "Đã chấm công vào", en: "Checked in" }
      : { vi: "Đã chấm công ra", en: "Checked out" };
  }
  if (result.status === "cooldown") {
    const time = result.last_at ? formatLocalTime(result.last_at) : "";
    return { vi: "Đã ghi nhận rồi", en: `Already recorded at ${time}` };
  }
  return { vi: "Không nhận diện được", en: "Not recognised — see your manager" };
}

function ResultCard({ result }: { result: CaptureResult }) {
  const { vi, en } = resultHeadline(result);
  const color =
    result.status === "matched"
      ? "var(--ok)"
      : result.status === "cooldown"
        ? "var(--warn)"
        : "var(--crit)";
  return (
    <div className="card stack" style={{ textAlign: "center" }} role="status">
      <div className="figure figure--lg" style={{ color }}>
        {vi}
      </div>
      <div className="muted">{en}</div>
      {result.person_name ? <div className="h1">{result.person_name}</div> : null}
      {result.status === "matched" && result.captured_at ? (
        <div className="muted">{formatLocalTime(result.captured_at)}</div>
      ) : null}
    </div>
  );
}

export default function AttendanceCamera({ door }: { door: DoorCamera }) {
  const config = parseAttendanceConfig(door.attendance_config);

  const [offline, setOffline] = useState(false);
  const [noFaceBanner, setNoFaceBanner] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [result, setResult] = useState<CaptureResult | null>(null);
  const [resultFlash, setResultFlash] = useState<CaptureStatus | null>(null);

  const onCapture = useCallback(async (embedding: number[]) => {
    if (embedding.length === 0) {
      setNoFaceBanner(true);
      window.setTimeout(() => setNoFaceBanner(false), NO_FACE_BANNER_MS);
      return;
    }
    try {
      const captured = await captureAttendance({
        embedding,
        capturedAt: new Date().toISOString(),
        modelVersion: FACE_MODEL_VERSION,
      });
      setCaptureError(null);
      setResult(captured);
      setResultFlash(captured.status);
      window.setTimeout(() => setResultFlash(null), RESULT_BORDER_MS);
      window.setTimeout(() => setResult(null), RESULT_CARD_MS);
    } catch (e: unknown) {
      setCaptureError(errorMessage(e));
    }
  }, []);

  const { videoRef, phase, error, candidate, flashing } = useDoorCamera({
    config,
    onCapture,
    holdMs: RESULT_CARD_MS,
  });

  // Every 60s whether or not anyone is at the door -- an offline door is
  // worse discovered from a manager's complaint than from its own banner.
  useEffect(() => {
    let cancelled = false;
    const beat = async () => {
      try {
        await sendAttendanceHeartbeat({
          deviceId: door.id,
          nodeId: door.org_node_id,
          mode: door.role,
        });
        if (!cancelled) setOffline(false);
      } catch {
        if (!cancelled) setOffline(true);
      }
    };
    void beat();
    const timer = setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS);
    const onOffline = () => setOffline(true);
    const onOnline = () => void beat();
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, [door.id, door.org_node_id, door.role]);

  async function handleSignOut() {
    await supabase().auth.signOut();
    window.location.reload();
  }

  if (door.revoked_at) {
    return (
      <div className="wrap">
        <div className="stack">
          <div className="empty">
            <h2 className="empty__title">This door has been revoked</h2>
            <p className="empty__body">
              It no longer records attendance. Everything it already sent is kept. Sign out to use
              this phone for something else.
            </p>
          </div>
          <button type="button" className="btn btn--ghost" onClick={() => void handleSignOut()}>
            Sign out
          </button>
        </div>
      </div>
    );
  }

  // The preview is mirrored for a front camera so people see themselves as in
  // a mirror; the zone is defined in camera-frame fractions, so its left edge
  // is mirrored the same way rather than transformed in place.
  const mirrored = config.facing === "user";
  const zoneLeft = mirrored ? 1 - config.zone.x - config.zone.w : config.zone.x;
  const videoStyle: CSSProperties = {
    width: "100%",
    display: "block",
    transform: mirrored ? "scaleX(-1)" : undefined,
  };
  const zoneStyle: CSSProperties = {
    position: "absolute",
    left: `${zoneLeft * 100}%`,
    top: `${config.zone.y * 100}%`,
    width: `${config.zone.w * 100}%`,
    height: `${config.zone.h * 100}%`,
    border: `3px solid ${zoneBorderColor(candidate, resultFlash)}`,
    borderRadius: "var(--radius-md)",
    pointerEvents: "none",
    transition: "border-color 150ms ease",
  };

  return (
    <div className="app">
      <header className="appbar">
        <span className="appbar__brand">{door.name}</span>
        <span className="appbar__spacer" />
        <span className="muted truncate">
          {door.role === "check_in" ? "Check-in door" : "Check-out door"}
        </span>
      </header>

      <main className="wrap">
        <div className="stack">
          {phase === "error" ? (
            <div className="banner banner--crit" role="alert">
              <span>{error}</span>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => window.location.reload()}
              >
                Retry
              </button>
            </div>
          ) : null}
          {offline ? (
            <div className="banner banner--warn">
              Offline — check-ins cannot be recorded until the network is back
            </div>
          ) : null}
          {captureError ? (
            <div className="banner banner--crit" role="alert">
              {captureError}
            </div>
          ) : null}
          {noFaceBanner ? (
            <div className="banner banner--warn">No face found — try again</div>
          ) : null}

          {phase === "loading-models" ? (
            <div className="card stack">
              <span className="skeleton">Loading face models (one time, ~6 MB)</span>
            </div>
          ) : null}
          {phase === "starting-camera" ? (
            <div className="card stack">
              <span className="skeleton">Starting camera</span>
            </div>
          ) : null}

          {phase === "running" ? (
            <>
              <div className="card card--flush">
                <div style={{ position: "relative", lineHeight: 0 }}>
                  <video ref={videoRef} muted playsInline autoPlay style={videoStyle} />
                  <div style={zoneStyle} />
                </div>
                <p
                  className="muted"
                  style={{ margin: 0, padding: "var(--space-3) var(--space-4)" }}
                >
                  {candidate ? "Hold still…" : "Stand inside the box, face the camera"}
                </p>
              </div>
              {result ? <ResultCard result={result} /> : null}
            </>
          ) : null}

          {/* Folded away like Capture's settings: a door is a kiosk, and a bare
              Sign out in the header is one stray tap from a dead door. */}
          <details className="card">
            <summary className="field__label">Settings</summary>
            <div className="stack">
              <button type="button" className="btn btn--ghost" onClick={() => void handleSignOut()}>
                Sign out
              </button>
            </div>
          </details>
        </div>
      </main>

      {flashing ? <div style={FLASH_OVERLAY_STYLE} /> : null}
    </div>
  );
}
