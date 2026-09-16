import { useCallback, useEffect, useId, useRef, useState } from "react";
import { errorMessage } from "../lib/errorMessage";
import { FUNCTIONS, functionLabel } from "../lib/functionsCatalog";
import { minuteRowId } from "../lib/minuteRowId";
import { flush, outbox } from "../lib/outbox";
import { type DeviceConfig, type DeviceRole, loadDeviceConfig, type Profile } from "../lib/session";
import { supabase } from "../lib/supabaseClient";
import { useOnline } from "../lib/useOnline";
import {
  type CaptureSession,
  endSession,
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

// enumerateDevices reports no facingMode, so the camera pointed at the belt can
// only be recognised by the name the platform gives it.
const REAR_CAMERA_LABEL = /back|rear|environment/i;

// lib.dom declares requestVideoFrameCallback as required; Safari on older iOS
// does not ship it, so it is probed at the call site instead of in the type.
type FrameScheduler = { requestVideoFrameCallback?: (cb: () => void) => number };

interface StationRow {
  id: string;
  name: string;
}

interface CameraOption {
  id: string;
  label: string;
}

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
  const [stations, setStations] = useState<StationRow[]>([]);
  const [cameras, setCameras] = useState<CameraOption[]>([]);
  const [cameraFunction, setCameraFunction] = useState<DeviceRole>("counting");
  const [stationId, setStationId] = useState("");
  const [cameraId, setCameraId] = useState("");
  const [starting, setStarting] = useState(false);
  const [running, setRunning] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [total, setTotal] = useState(0);
  const [queued, setQueued] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const online = useOnline();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const device = await loadDeviceConfig(profile.id);
        if (cancelled) return;
        setConfig(device);
        if (!device) return;
        // devices.role and devices.station_id are the pairing defaults a new
        // session is pre-filled with, and nothing else reads them.
        setCameraFunction(device.role);
        setStationId(device.station_id ?? "");
        if (device.revoked_at) return;
        // A reloaded tab is still on the line, so it resumes its own open
        // session instead of asking an owner to set the camera up again.
        const resumed = await loadOpenSession(device.id);
        if (!cancelled) setSession(resumed);
      } catch (e: unknown) {
        if (!cancelled) setError(errorMessage(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [profile.id]);

  // The outbox outlives the page, so what is waiting has to be read from it at
  // startup: a phone reopened after a night offline would otherwise say "synced"
  // while its queue sat on disk. A failed read leaves the pill alone rather than
  // replacing the counting screen with an error.
  useEffect(() => {
    outbox
      .count()
      .then(setQueued)
      .catch(() => undefined);
  }, []);

  // A camera that cannot list the estate still has the station its pairing
  // chose, so an empty or failed read narrows the choice instead of blocking it.
  useEffect(() => {
    void (async () => {
      try {
        const { data } = await supabase()
          .from("stations")
          .select("id, name")
          .eq("active", true)
          .order("name");
        setStations((data as StationRow[] | null) ?? []);
      } catch {
        setStations([]);
      }
    })();
  }, []);

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

  const sendOutbox = useCallback(async () => {
    await flush(async (table, payload) => {
      const { error: writeError } = await supabase().from(table).upsert(payload);
      if (writeError) throw writeError;
    });
    setQueued(await outbox.count());
  }, []);

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
      setQueued(await outbox.count());
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
    // Deliberately NOT cleared. The row id is derived from (device, minute), so
    // handing the same minute in twice upserts one row rather than colliding on
    // the table's unique key - and keeping the bucket means the second write
    // carries the FULL minute, not just the part after the page came back.
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
      await sendOutbox();
    }, 30_000);
    return () => clearInterval(timer);
  }, [running, config, session, sendOutbox]);

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
          stationId: stationId || null,
          cameraFunction,
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

  const assignedStationId = config.station_id ?? "";
  // The pairing default stays selectable even when the estate list is out of
  // this camera's reach, so a phone can always start on its own line.
  const stationChoices =
    assignedStationId && !stations.some((s) => s.id === assignedStationId)
      ? [{ id: assignedStationId, name: "Assigned station" }, ...stations]
      : stations;

  return (
    <div className="app">
      <header className="appbar">
        <span className="appbar__brand">{config.name}</span>
        <span className="muted truncate">
          {session ? functionLabel(session.camera_function) : "Not on the line"}
        </span>
        <span className="appbar__spacer" />
        <span className={online && queued === 0 ? "pill pill--ok" : "pill pill--warn"}>
          {syncLabel(online, queued)}
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
              Offline. Counting carries on and every minute is saved on this phone; it syncs by
              itself when the connection returns.
            </div>
          )}
          {online && queued > 0 ? (
            <div className="banner banner--info">
              {queued} {queued === 1 ? "minute is" : "minutes are"} still waiting to sync. They are
              saved on this phone and go out on the next sync — nothing is lost.
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
                <div className="row">
                  <span className="label">{functionLabel(session.camera_function)}</span>
                  <span className="muted truncate">
                    {stationName(stationChoices, session.station_id)}
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
              <h1 className="h2">What is this camera doing?</h1>

              <div className="field">
                <label className="field__label" htmlFor={`${fieldId}-function`}>
                  Function
                </label>
                <select
                  id={`${fieldId}-function`}
                  className="field__input"
                  value={cameraFunction}
                  onChange={(e) => setCameraFunction(e.target.value as DeviceRole)}
                >
                  {FUNCTIONS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label className="field__label" htmlFor={`${fieldId}-station`}>
                  Station
                </label>
                <select
                  id={`${fieldId}-station`}
                  className="field__input"
                  value={stationId}
                  onChange={(e) => setStationId(e.target.value)}
                >
                  <option value="">No station</option>
                  {stationChoices.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <span className="field__hint">
                  A session with no station still counts and still keeps every minute, but its
                  figures never reach the wall.
                </span>
              </div>

              <CameraField
                id={`${fieldId}-camera`}
                cameras={cameras}
                value={cameraId}
                onChange={setCameraId}
              />

              <button
                type="button"
                className="btn btn--primary"
                disabled={starting}
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

function stationName(stations: StationRow[], id: string | null): string {
  if (!id) return "No station";
  return stations.find((s) => s.id === id)?.name ?? "Assigned station";
}

function formatElapsed(startedAt: string, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((nowMs - new Date(startedAt).getTime()) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

function syncLabel(isOnline: boolean, queued: number): string {
  if (!isOnline) return queued > 0 ? `offline · ${queued} queued` : "offline";
  return queued > 0 ? `${queued} queued` : "synced";
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
