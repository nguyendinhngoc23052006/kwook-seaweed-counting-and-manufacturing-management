import { useCallback, useEffect, useId, useRef, useState } from "react";
import { errorMessage } from "../lib/errorMessage";
import { functionLabel } from "../lib/functionsCatalog";
import { type DeviceConfig, loadDeviceConfig, type Profile } from "../lib/session";
import { isStreamConfigured, startStream, stopStream } from "../lib/stream";
import { supabase } from "../lib/supabaseClient";
import { useOnline } from "../lib/useOnline";
import {
  type CaptureSession,
  type DeviceAssignment,
  endSession,
  loadAssignment,
  loadOpenSession,
  startSession,
} from "../services/captureSessions";

// No counter is attached. src/vision's Otsu/morphology/connected-components
// core was retired with the move to the org camera stack, and its replacement
// is being built on OpenCV, MediaPipe and ONNX Runtime Web. Until one exists
// this screen runs the camera and proves it is alive; it files no counts.
//
// A session still means what it always meant -- THIS CAMERA IS RUNNING -- and
// asserts nothing about a tally. camera_count_minutes simply receives no rows,
// which is absence of measurement, not a measured zero. A stubbed counter
// filing count: 0 every minute would be indistinguishable on the wall from a
// belt that genuinely ran empty, and that is the one thing never to ship.
const ALGORITHM_VERSION = null;
// A camera left on the setup screen re-reads its placement on this beat, so an
// owner who assigns a station does not also have to walk to the phone.
const ASSIGNMENT_POLL_MS = 30_000;

// enumerateDevices reports no facingMode, so the camera pointed at the belt can
// only be recognised by the name the platform gives it.
const REAR_CAMERA_LABEL = /back|rear|environment/i;

interface CameraOption {
  id: string;
  label: string;
}

export default function Capture({ profile }: { profile: Profile }) {
  const fieldId = useId();
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [config, setConfig] = useState<DeviceConfig | null>(null);
  // The open session is the whole statement of what this camera is doing now.
  // No session means it is off the line in that instant, not ageing towards it.
  const [session, setSession] = useState<CaptureSession | null>(null);
  // Where the OWNER put this camera. The phone reads it and shows it; it has no
  // way to change it, which is why nothing here is a form control.
  const [assignment, setAssignment] = useState<DeviceAssignment | null>(null);
  const [cameras, setCameras] = useState<CameraOption[]>([]);
  const [cameraId, setCameraId] = useState("");
  const [starting, setStarting] = useState(false);
  const [running, setRunning] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const online = useOnline();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const device = await loadDeviceConfig(profile.id);
        if (cancelled) return;
        setConfig(device);
        if (!device || device.revoked_at) return;
        // A reloaded tab is still on the line, so it resumes its own open
        // session instead of asking an owner to set the camera up again.
        const [placement, resumed] = await Promise.all([
          loadAssignment(device.id),
          loadOpenSession(device.id),
        ]);
        if (cancelled) return;
        setAssignment(placement);
        setSession(resumed);
      } catch (e: unknown) {
        if (!cancelled) setError(errorMessage(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [profile.id]);

  const refreshCameras = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      // Until permission is granted the platform returns placeholder entries
      // with no id and no label. Those cannot be handed to getUserMedia, so the
      // picker stays empty until a stream has filled the real ones in.
      setCameras(
        devices
          .filter((d) => d.kind === "videoinput" && d.deviceId !== "")
          .map((d, index) => ({ id: d.deviceId, label: d.label || `Camera ${index + 1}` })),
      );
    } catch {
      setCameras([]);
    }
  }, []);

  useEffect(() => {
    void refreshCameras();
  }, [refreshCameras]);

  // Only between sessions: re-picking a default mid-session would reopen the
  // stream under the operator.
  useEffect(() => {
    if (session || cameras.length === 0) return;
    setCameraId((current) =>
      cameras.some((c) => c.id === current) ? current : chooseDefaultCamera(cameras),
    );
  }, [session, cameras]);

  // Placement can change while this phone sits on the setup screen, and the
  // owner must not have to walk to the floor to make it notice.
  useEffect(() => {
    if (!config || config.revoked_at || session) return;
    const deviceId = config.id;
    const timer = setInterval(() => {
      loadAssignment(deviceId)
        .then(setAssignment)
        .catch(() => undefined);
    }, ASSIGNMENT_POLL_MS);
    return () => clearInterval(timer);
  }, [config, session]);

  useEffect(() => {
    if (!session) return;
    let stopped = false;
    let stream: MediaStream | null = null;
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: cameraId
            ? { deviceId: { exact: cameraId }, width: { ideal: 1280 } }
            : { facingMode: "environment", width: { ideal: 1280 } },
          audio: false,
        });
        if (stopped) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play();
        }
        await navigator.wakeLock?.request("screen").catch(() => undefined);
        setError(null);
        setRunning(true);
        // The one place the live-view publisher attaches. Guarded so a build
        // with no Realtime app behaves exactly as it does without the module,
        // and never awaited or surfaced: a publisher that cannot connect must
        // not stop this phone counting (rule 5).
        if (isStreamConfigured()) void startStream(stream, session.id).catch(() => undefined);
        // Names arrive only once a stream exists, so the picker is filled in
        // here rather than left saying "Camera 1" on a laptop with four.
        void refreshCameras();
      } catch (e: unknown) {
        if (!stopped) setError(errorMessage(e));
      }
    })();
    return () => {
      stopped = true;
      setRunning(false);
      if (isStreamConfigured()) stopStream();
      for (const track of stream?.getTracks() ?? []) track.stop();
      const video = videoRef.current;
      if (video) video.srcObject = null;
    };
  }, [session, cameraId, refreshCameras]);

  useEffect(() => {
    if (!running || !config || !session) return;
    const timer = setInterval(async () => {
      await supabase().from("camera_device_heartbeats").insert({
        device_id: config.id,
        // What this camera is doing comes from the session it is running, never
        // from the device row it was paired with.
        mode: session.camera_function,
      });
    }, 30_000);
    return () => clearInterval(timer);
  }, [running, config, session]);

  useEffect(() => {
    if (!session) return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [session]);

  async function handleStart() {
    if (!config) return;
    setError(null);
    setStarting(true);
    try {
      setSession(
        await startSession({
          deviceId: config.id,
          algorithmVersion: ALGORITHM_VERSION,
        }),
      );
    } catch (e: unknown) {
      setError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  }

  async function handleStop() {
    const current = session;
    setSession(null);
    if (current) {
      try {
        await endSession(current.id, "stopped");
      } catch (e: unknown) {
        setError(errorMessage(e));
      }
    }
  }

  // This screen carries no navigation on purpose, so a phone paired as a camera
  // by mistake has no other way back to the sign-in screen. A session that
  // cannot be closed from here is left for an owner to end from the wall rather
  // than trapping the phone on the counting screen.
  async function handleSignOut() {
    const current = session;
    if (current) await endSession(current.id, "signed_out").catch(() => undefined);
    await supabase().auth.signOut();
    window.location.reload();
  }

  if (!config)
    return (
      <div className="wrap">
        <div className="stack">
          {error ? (
            <div className="banner banner--crit" role="alert">
              {error}
            </div>
          ) : (
            <span className="skeleton">Loading this camera</span>
          )}
          <SignOutFooter onSignOut={handleSignOut} />
        </div>
      </div>
    );
  if (config.revoked_at) {
    return (
      <div className="wrap">
        <div className="stack">
          <div className="empty">
            <h2 className="empty__title">This camera has been unpaired</h2>
            <p className="empty__body">
              It has stopped. Everything it already sent is kept. A manager can pair this phone
              again, or sign out to use it normally.
            </p>
          </div>
          <SignOutFooter onSignOut={handleSignOut} />
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="appbar">
        <span className="appbar__brand">{config.name}</span>
        <span className="muted truncate">
          {session ? functionLabel(session.camera_function) : "Not on the line"}
        </span>
        <span className="appbar__spacer" />
        <span className={online ? "pill pill--ok" : "pill pill--warn"}>
          {online ? "online" : "offline"}
        </span>
      </header>

      <main className="wrap">
        <div className="stack">
          {/* A camera error is recoverable — a denied permission can be granted and a busy
              device frees up — so it never replaces the screen it would strand. */}
          {error ? (
            <div className="banner banner--crit" role="alert">
              <span>{error}</span>
              {session ? (
                // Reloading re-reads the device row and resumes the open
                // session, so the camera comes back without a new setup.
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => window.location.reload()}
                >
                  Try again
                </button>
              ) : null}
            </div>
          ) : null}
          {online ? null : (
            <div className="banner banner--warn">
              Offline. This camera keeps running; the wall will not see it as alive until the
              connection returns.
            </div>
          )}

          {session ? (
            <>
              <div className="card stack">
                {/* The session's own snapshot, not today's assignment: if an
                    owner moves this camera mid-shift, the screen keeps saying
                    where these counts are actually being filed. */}
                <div className="row">
                  <span className="label">{functionLabel(session.camera_function)}</span>
                  <span className="muted truncate">
                    {placeLabel(session.line_name, session.station_name)}
                  </span>
                  <span className="muted">running {formatElapsed(session.started_at, nowMs)}</span>
                </div>
                <div className="banner banner--info">
                  No counter is attached yet. This camera is running and the wall can see it is
                  alive, but nothing is being counted — the new pipeline is still being built.
                  Minutes are not being filed, so no figure here is a measured zero.
                </div>
                <div className="row">
                  <span className={running ? "pill pill--ok" : "pill pill--warn"}>
                    {running ? "● running" : "opening camera"}
                  </span>
                  <button
                    type="button"
                    className="btn btn--danger"
                    onClick={() => void handleStop()}
                  >
                    Stop
                  </button>
                </div>
              </div>

              <div className="card card--flush">
                <video
                  ref={videoRef}
                  playsInline
                  muted
                  style={{ width: "100%", display: "block" }}
                />
              </div>

              <details className="card">
                <summary className="field__label">Settings</summary>
                <div className="stack">
                  <CameraField
                    id={`${fieldId}-live-camera`}
                    cameras={cameras}
                    value={cameraId}
                    onChange={setCameraId}
                  />
                </div>
              </details>
            </>
          ) : (
            <div className="card stack">
              <h1 className="h2">This camera</h1>

              {/* Read-only on purpose. Placement is the owner's to set, and a
                  phone that could name its own station could name a different
                  one — so there is nothing to change here, only to read. */}
              {assignment ? (
                <div className="stack">
                  {/* A camera can now read the lines on its own node, so null
                      here means the station has not been placed on one -- not
                      that the phone is forbidden to look. */}
                  {assignment.lineName ? (
                    <div className="field">
                      <span className="label">Line</span>
                      <span>{assignment.lineName}</span>
                    </div>
                  ) : null}
                  <div className="field">
                    <span className="label">Station</span>
                    <span>
                      {assignment.stationName ?? (assignment.stationId ? "Assigned" : "—")}
                    </span>
                  </div>
                  <div className="field">
                    <span className="label">Function</span>
                    <span>{functionLabel(assignment.cameraFunction)}</span>
                  </div>
                </div>
              ) : (
                <span className="skeleton">Reading this camera's assignment</span>
              )}

              {assignment && !assignment.stationId ? (
                <div className="banner banner--warn">
                  This camera has not been given a station yet, so nothing it records can be filed
                  anywhere. A manager assigns it a line and a station from Cameras in the management
                  hub; this phone cannot set its own.
                </div>
              ) : null}

              <CameraField
                id={`${fieldId}-camera`}
                cameras={cameras}
                value={cameraId}
                onChange={setCameraId}
              />

              <button
                type="button"
                className="btn btn--primary"
                disabled={starting || !assignment?.stationId}
                onClick={() => void handleStart()}
              >
                {starting ? "Starting…" : "Start this camera"}
              </button>
            </div>
          )}

          <SignOutFooter onSignOut={handleSignOut} />
        </div>
      </main>
    </div>
  );
}

function CameraField({
  id,
  cameras,
  value,
  onChange,
}: {
  id: string;
  cameras: CameraOption[];
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        Camera
      </label>
      <select
        id={id}
        className="field__input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Automatic (rear camera)</option>
        {cameras.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>
      {cameras.length === 0 ? (
        <span className="field__hint">
          This browser lists its cameras only once one has been allowed. Start this camera, then
          come back here to pick a different one.
        </span>
      ) : null}
    </div>
  );
}

function chooseDefaultCamera(cameras: CameraOption[]): string {
  return (cameras.find((c) => REAR_CAMERA_LABEL.test(c.label)) ?? cameras[0])?.id ?? "";
}

function placeLabel(lineName: string | null, stationName: string | null): string {
  if (!stationName) return "No station";
  return lineName ? `${lineName} · ${stationName}` : stationName;
}

function formatElapsed(startedAt: string, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((nowMs - new Date(startedAt).getTime()) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

function SignOutFooter({ onSignOut }: { onSignOut: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);

  return (
    <footer className="row">
      {confirming ? (
        <div className="banner banner--warn">
          <span>This phone will stop running and return to the sign-in screen.</span>
          <button type="button" className="btn btn--danger" onClick={() => void onSignOut()}>
            Sign out
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => setConfirming(false)}>
            Keep running
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => setConfirming(true)}
        >
          This is not a camera — sign out
        </button>
      )}
    </footer>
  );
}
