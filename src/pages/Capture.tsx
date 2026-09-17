import { useCallback, useEffect, useId, useRef, useState } from "react";
import { errorMessage } from "../lib/errorMessage";
import { functionLabel } from "../lib/functionsCatalog";
import { minuteRowId } from "../lib/minuteRowId";
import { flush, outbox } from "../lib/outbox";
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
import { connectedComponents, filterBlobs } from "../vision/connectedComponents";
import { LineCounter } from "../vision/lineCounter";
import { close, open } from "../vision/morphology";
import { binarize, otsu, toGray } from "../vision/otsu";

const ALGORITHM_VERSION = "line-counter@1";
const PROC_WIDTH = 320;
const MIN_BLOB_AREA = 120; // px at 320-wide: below this is glare/specks, not leaves
const MAX_BLOB_AREA = 20000;
const MIN_FILL_RATIO = 0.35; // reject sparse/stringy dark clutter (shadows, seams)
const MIN_SEPARABILITY = 0.08; // skip low-contrast frames rather than count noise

// The queue drains on this beat whether or not this camera is on the line.
const SYNC_INTERVAL_MS = 30_000;
// A camera left on the setup screen re-reads its placement on this beat, so an
// owner who assigns a station does not also have to walk to the phone.
const ASSIGNMENT_POLL_MS = 30_000;

// enumerateDevices reports no facingMode, so the camera pointed at the belt can
// only be recognised by the name the platform gives it.
const REAR_CAMERA_LABEL = /back|rear|environment/i;

// lib.dom declares requestVideoFrameCallback as required; Safari on older iOS
// does not ship it, so it is probed at the call site instead of in the type.
type FrameScheduler = { requestVideoFrameCallback?: (cb: () => void) => number };

interface CameraOption {
  id: string;
  label: string;
}

// What the last flush actually found. A waiting row is safe on this phone and
// will go out; a refused row carries a server verdict this phone cannot argue
// with, so calling it "waiting" - or telling anyone nothing is lost - is a lie.
interface SyncState {
  waiting: number;
  refused: number;
  refusedCodes: string[];
}

const NOTHING_PENDING: SyncState = { waiting: 0, refused: 0, refusedCodes: [] };

export default function Capture({ profile }: { profile: Profile }) {
  const fieldId = useId();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const counterRef = useRef<LineCounter | null>(null);
  // When a leaf crosses the line the line itself flashes green until this time.
  const flashUntilRef = useRef(0);
  const minuteRef = useRef<{ key: string; count: number; frames: number }>({
    key: "",
    count: 0,
    frames: 0,
  });

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
  const [total, setTotal] = useState(0);
  const [sync, setSync] = useState<SyncState>(NOTHING_PENDING);
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

  // insert, not upsert: the row id is derived from (device, minute) and
  // count_minutes is unique on the same pair, so a duplicate has to reach the
  // server as 23505 - the one verdict the outbox reads as "already recorded".
  // An upsert would instead overwrite a minute the server already accepted and
  // re-run nothing of the receipt trigger's stamping.
  const sendOutbox = useCallback(async () => {
    const { waiting, refused } = await flush(async (table, payload) => {
      const { error: writeError } = await supabase().from(table).insert(payload);
      if (writeError) throw writeError;
    });
    // The codes are not in the flush result and a refusal is rare, so they are
    // read back only when there is something to name.
    setSync({ waiting, refused, refusedCodes: refused > 0 ? await refusedCodes() : [] });
  }, []);

  // The queue has to drain whether or not this camera is on the line. While the
  // only flush hung off a running session, "Not on the line" with rows queued
  // was a state that could never recover: nothing was left to send them.
  useEffect(() => {
    const send = () => {
      sendOutbox().catch(() => undefined);
    };
    send();
    const timer = setInterval(send, SYNC_INTERVAL_MS);
    window.addEventListener("online", send);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", send);
    };
  }, [sendOutbox]);

  const persistMinute = useCallback(
    async (device: DeviceConfig, minuteKey: string, count: number, frames: number) => {
      const id = await minuteRowId(device.id, minuteKey);
      await outbox.add({
        id,
        table: "count_minutes",
        payload: {
          id,
          tenant_id: device.tenant_id,
          device_id: device.id,
          // Where this camera is pointed comes from the session it is running,
          // never from the device row it was paired with.
          station_id: session?.station_id ?? null,
          session_id: session?.id ?? null,
          minute: minuteKey,
          count,
          tracks_created: counterRef.current?.stats().created ?? 0,
          tracks_counted: counterRef.current?.stats().counted ?? 0,
          achieved_fps: frames / 60,
          algorithm_version: ALGORITHM_VERSION,
        },
        queuedAt: Date.now(),
      });
      // Waiting for the 30s timer can leave a finished minute 90 seconds old
      // before the wall sees it. The timer stays on as the retry path for when
      // this send fails offline.
      await sendOutbox().catch(() => undefined);
    },
    [session, sendOutbox],
  );

  // The bucket only rolls over when the NEXT minute's first frame arrives, so
  // every stop, hide and sign-out has to hand in the minute in progress or it
  // is lost. Never rejects: a camera is not stopped by a failed save.
  const flushOpenMinute = useCallback(async () => {
    const bucket = minuteRef.current;
    if (!config || !bucket.key || bucket.frames === 0) return;
    const { key, count, frames } = bucket;
    // Deliberately NOT cleared. The outbox is keyed on that same derived id, so
    // handing the minute in twice REPLACES its own queued row rather than
    // adding a second, and the copy that survives carries the FULL minute, not
    // just the part before the page went away.
    try {
      await persistMinute(config, key, count, frames);
    } catch (e: unknown) {
      setError(errorMessage(e));
    }
  }, [config, persistMinute]);

  const drawOverlay = useCallback((w: number, h: number, lineY: number) => {
    const overlay = overlayRef.current;
    const video = videoRef.current;
    if (!overlay || !video) return;

    const rect = video.getBoundingClientRect();
    if (overlay.width !== rect.width || overlay.height !== rect.height) {
      overlay.width = rect.width;
      overlay.height = rect.height;
    }
    const ctx = overlay.getContext("2d");
    if (!ctx) return;

    const sx = overlay.width / w;
    const sy = overlay.height / h;
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    // Tracks: amber while approaching, filled green once counted.
    ctx.font = "600 12px ui-sans-serif, system-ui, sans-serif";
    for (const t of counterRef.current?.activeTracks() ?? []) {
      ctx.beginPath();
      ctx.arc(t.cx * sx, t.cy * sy, 6, 0, Math.PI * 2);
      ctx.fillStyle = t.counted ? "#2e7d5b" : "#cf9134";
      ctx.fill();
    }

    // The counting line, drawn last so nothing hides it. It flashes green for a
    // moment whenever a leaf triggers it.
    const flashing = performance.now() < flashUntilRef.current;
    const y = lineY * sy;
    ctx.strokeStyle = flashing ? "#2e7d5b" : "#ff3b30";
    ctx.lineWidth = flashing ? 6 : 3;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(overlay.width, y);
    ctx.stroke();

    ctx.fillStyle = flashing ? "#2e7d5b" : "#ff3b30";
    ctx.fillText("COUNT LINE  ▼ direction of travel", 8, y - 8);
  }, []);

  const processFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const counter = counterRef.current;
    if (!video || !canvas || !counter || !config || video.videoWidth === 0) return;

    const scale = PROC_WIDTH / video.videoWidth;
    const w = PROC_WIDTH;
    const h = Math.round(video.videoHeight * scale);
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, w, h);

    const gray = toGray(ctx.getImageData(0, 0, w, h).data);
    const { threshold, separability } = otsu(gray);

    // Low separability means the frame has no clear leaf-vs-belt split (a hand
    // over the lens, near-uniform dark). Feed the tracker an empty frame so
    // live tracks age out, but never manufacture blobs from noise.
    let blobs: ReturnType<typeof connectedComponents> = [];
    if (separability >= MIN_SEPARABILITY) {
      // open() erodes then dilates: specks vanish. close() fills pinholes so one
      // leaf stays one blob. Then area + compactness reject what's left.
      const mask = close(open(binarize(gray, threshold, true), w, h), w, h);
      blobs = filterBlobs(connectedComponents(mask, w, h), {
        minArea: MIN_BLOB_AREA,
        maxArea: MAX_BLOB_AREA,
        minFill: MIN_FILL_RATIO,
      });
    }

    // The line lives mid-frame whatever the camera's aspect ratio; setLineY
    // moves it without resetting the tally.
    const lineY = Math.round(h / 2);
    counter.setLineY(lineY);
    const newly = counter.update(blobs);
    if (newly > 0) flashUntilRef.current = performance.now() + 350;
    const minuteKey = `${new Date().toISOString().slice(0, 16)}:00Z`;
    const bucket = minuteRef.current;

    if (bucket.key && bucket.key !== minuteKey) {
      void persistMinute(config, bucket.key, bucket.count, bucket.frames);
      bucket.count = 0;
      bucket.frames = 0;
    }
    bucket.key = minuteKey;
    bucket.count += newly;
    bucket.frames += 1;

    if (newly > 0) setTotal(counter.stats().counted);
    drawOverlay(w, h, lineY);
  }, [config, persistMinute, drawOverlay]);

  // The tally belongs to the session, not to the stream: switching camera
  // mid-shift must not reset the figure on the wall or on this screen.
  useEffect(() => {
    if (!session) return;
    counterRef.current = new LineCounter({
      lineY: 0, // set every frame to mid-frame once the video's height is known

      beltDy: 8,
      gateRadius: 24,
      minTrackAge: 3,
      maxMissed: 2,
    });
    minuteRef.current = { key: "", count: 0, frames: 0 };
    setTotal(0);
    return () => {
      counterRef.current = null;
    };
  }, [session]);

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
    if (!running || !config) return;
    let active = true;
    const video = videoRef.current;

    const loop = () => {
      if (!active) return;
      processFrame();
      const scheduler = video as (HTMLVideoElement & FrameScheduler) | null;
      if (scheduler?.requestVideoFrameCallback) scheduler.requestVideoFrameCallback(loop);
      else setTimeout(loop, 66);
    };
    loop();
    return () => {
      active = false;
    };
  }, [running, config, processFrame]);

  useEffect(() => {
    if (!running || !config || !session) return;
    const timer = setInterval(async () => {
      await supabase().from("device_heartbeats").insert({
        tenant_id: config.tenant_id,
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

  // A backgrounded phone can be killed by the OS without ever firing pagehide,
  // so hiding is the last reliable moment to hand in the minute in progress.
  useEffect(() => {
    if (!session) return;
    const saveOpenMinute = () => {
      void flushOpenMinute();
    };
    const saveWhenHidden = () => {
      if (document.hidden) saveOpenMinute();
    };
    window.addEventListener("pagehide", saveOpenMinute);
    document.addEventListener("visibilitychange", saveWhenHidden);
    return () => {
      window.removeEventListener("pagehide", saveOpenMinute);
      document.removeEventListener("visibilitychange", saveWhenHidden);
    };
  }, [session, flushOpenMinute]);

  async function handleStart() {
    if (!config) return;
    setError(null);
    setStarting(true);
    try {
      setSession(
        await startSession({
          tenantId: config.tenant_id,
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
    // Started before the teardown so the open minute is read while the counter
    // is still alive; the camera then goes dark without waiting for the network.
    const saved = flushOpenMinute();
    setSession(null);
    if (current) {
      try {
        await endSession(current.id, "stopped");
      } catch (e: unknown) {
        setError(errorMessage(e));
      }
    }
    await saved;
  }

  // This screen carries no navigation on purpose, so a phone paired as a camera
  // by mistake has no other way back to the sign-in screen. A session that
  // cannot be closed from here is left for an owner to end from the wall rather
  // than trapping the phone on the counting screen.
  async function handleSignOut() {
    const current = session;
    await flushOpenMinute();
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
              It has stopped counting. Everything it already sent is kept. An owner can pair this
              phone again, or sign out to use it normally.
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
        <span className={syncPillClass(online, sync)}>{syncLabel(online, sync)}</span>
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
              Offline. Counting carries on and every minute is saved on this phone; it syncs by
              itself when the connection returns.
            </div>
          )}
          {online && sync.waiting > 0 ? (
            <div className="banner banner--info">
              {sync.waiting} {sync.waiting === 1 ? "minute is" : "minutes are"} still waiting to
              sync. They are saved on this phone and go out on the next sync — nothing is lost.
            </div>
          ) : null}
          {/* Not "waiting": the server looked at these rows and said no, so no
              amount of connection will send them. Naming the SQLSTATE is what
              lets an owner tell a revoked camera from a broken schema. */}
          {sync.refused > 0 ? (
            <div className="banner banner--crit" role="alert">
              {sync.refused} {sync.refused === 1 ? "minute was" : "minutes were"} refused by the
              server{sync.refusedCodes.length > 0 ? ` (${sync.refusedCodes.join(", ")})` : ""}. They
              are still on this phone but will not sync on their own — show this screen to an owner.
            </div>
          ) : null}
          {session && !session.station_id ? (
            <div className="banner banner--warn">
              No station on this session — these counts will not appear on the wall.
            </div>
          ) : null}

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
                <div>
                  <div className="label">Counted this session</div>
                  <div className="figure">{total}</div>
                </div>
                <div className="row">
                  <span className={running ? "pill pill--ok" : "pill pill--warn"}>
                    {running ? "● counting" : "opening camera"}
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
                {/* The overlay has to sit exactly on the video box, and no class in the design
                    system can express that. */}
                <div style={{ position: "relative", lineHeight: 0 }}>
                  <video
                    ref={videoRef}
                    playsInline
                    muted
                    style={{ width: "100%", display: "block" }}
                  />
                  <canvas
                    ref={overlayRef}
                    style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
                  />
                </div>
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
                  {/* Omitted rather than shown as "none" when it is null: a
                      camera cannot read `lines`, so null here means "not
                      visible to this phone", not "no line". The session card
                      shows it once the server has snapshotted it. */}
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
                  This camera has not been given a station yet, so it has nothing to count for. An
                  owner assigns it a line and a station from the Cameras screen; this phone cannot
                  set its own.
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
                {starting ? "Starting…" : "Start counting"}
              </button>
            </div>
          )}

          <SignOutFooter onSignOut={handleSignOut} />
        </div>
      </main>
      <canvas ref={canvasRef} hidden />
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
          This browser lists its cameras only once one has been allowed. Start counting, then come
          back here to pick a different one.
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

// A refused row keeps the server's verdict on it. Distinct codes only: twenty
// minutes refused for one reason are one thing to tell an owner, not twenty.
async function refusedCodes(): Promise<string[]> {
  const records = await outbox.all();
  return [
    ...new Set(
      records
        .filter((record) => record.rejectedAt !== undefined)
        .map((record) => record.rejectedCode ?? "no code"),
    ),
  ];
}

function formatElapsed(startedAt: string, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((nowMs - new Date(startedAt).getTime()) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

function syncLabel(isOnline: boolean, sync: SyncState): string {
  if (sync.refused > 0) return `${sync.refused} refused`;
  if (!isOnline) return sync.waiting > 0 ? `offline · ${sync.waiting} queued` : "offline";
  return sync.waiting > 0 ? `${sync.waiting} queued` : "synced";
}

function syncPillClass(isOnline: boolean, sync: SyncState): string {
  if (sync.refused > 0) return "pill pill--crit";
  if (!isOnline || sync.waiting > 0) return "pill pill--warn";
  return "pill pill--ok";
}

function SignOutFooter({ onSignOut }: { onSignOut: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);

  return (
    <footer className="row">
      {confirming ? (
        <div className="banner banner--warn">
          <span>This phone will stop counting and return to the sign-in screen.</span>
          <button type="button" className="btn btn--danger" onClick={() => void onSignOut()}>
            Sign out
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => setConfirming(false)}>
            Keep counting
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
