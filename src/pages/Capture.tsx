import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../lib/errorMessage";
import { functionLabel } from "../lib/functionsCatalog";
import { flush, outbox } from "../lib/outbox";
import { type DeviceConfig, loadDeviceConfig, type Profile } from "../lib/session";
import { supabase } from "../lib/supabaseClient";
import { useOnline } from "../lib/useOnline";
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

// lib.dom declares requestVideoFrameCallback as required; Safari on older iOS
// does not ship it, so it is probed at the call site instead of in the type.
type FrameScheduler = { requestVideoFrameCallback?: (cb: () => void) => number };

export default function Capture({ profile }: { profile: Profile }) {
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
  const [running, setRunning] = useState(false);
  const [total, setTotal] = useState(0);
  const [queued, setQueued] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const online = useOnline();

  useEffect(() => {
    loadDeviceConfig(profile.id)
      .then(setConfig)
      .catch((e: unknown) => setError(errorMessage(e)));
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

  const persistMinute = useCallback(
    async (device: DeviceConfig, minuteKey: string, count: number, frames: number) => {
      const id = crypto.randomUUID();
      await outbox.add({
        id,
        table: "count_minutes",
        payload: {
          id,
          tenant_id: device.tenant_id,
          device_id: device.id,
          station_id: device.station_id,
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
    },
    [],
  );

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
    ctx.fillText("COUNT LINE  \u25bc direction of travel", 8, y - 8);
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
    if (!running || !config) return;
    const timer = setInterval(async () => {
      await supabase().from("device_heartbeats").insert({
        tenant_id: config.tenant_id,
        device_id: config.id,
        mode: config.role,
      });
      await flush(async (table, payload) => {
        const { error } = await supabase().from(table).upsert(payload);
        if (error) throw error;
      });
      setQueued(await outbox.count());
    }, 30_000);
    return () => clearInterval(timer);
  }, [running, config]);

  async function start() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 } },
        audio: false,
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      counterRef.current = new LineCounter({
        lineY: 0, // set every frame to mid-frame once the video's height is known

        beltDy: 8,
        gateRadius: 24,
        minTrackAge: 3,
        maxMissed: 2,
      });
      await navigator.wakeLock?.request("screen").catch(() => undefined);
      setRunning(true);
    } catch (e: unknown) {
      setError(errorMessage(e));
    }
  }

  function stop() {
    const v = videoRef.current;
    const stream = (v?.srcObject as MediaStream | null) ?? null;
    for (const track of stream?.getTracks() ?? []) track.stop();
    if (v) v.srcObject = null;
    setRunning(false);
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
          <SignOutFooter />
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
          <SignOutFooter />
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="appbar">
        <span className="appbar__brand">{config.name}</span>
        <span className="muted">{functionLabel(config.role)}</span>
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
              <button type="button" className="btn btn--primary" onClick={start}>
                Try again
              </button>
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
          {config.station_id ? null : (
            <div className="banner banner--warn">
              No station assigned — these counts will not appear on the wall.
            </div>
          )}

          <div className="card stack">
            <div>
              <div className="label">Counted this session</div>
              <div className="figure">{total}</div>
            </div>
            <div className="row">
              {running ? (
                <>
                  <span className="pill pill--ok">● counting</span>
                  <button type="button" className="btn" onClick={stop}>
                    Stop
                  </button>
                </>
              ) : (
                <button type="button" className="btn btn--primary" onClick={start}>
                  Start counting
                </button>
              )}
            </div>
          </div>

          <div className="card card--flush">
            {/* The overlay has to sit exactly on the video box, and no class in the design
                system can express that. */}
            <div style={{ position: "relative", lineHeight: 0 }}>
              <video ref={videoRef} playsInline muted style={{ width: "100%", display: "block" }} />
              <canvas
                ref={overlayRef}
                style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
              />
            </div>
          </div>

          <SignOutFooter />
        </div>
      </main>
      <canvas ref={canvasRef} hidden />
    </div>
  );
}

function syncLabel(isOnline: boolean, queued: number): string {
  if (!isOnline) return queued > 0 ? `offline · ${queued} queued` : "offline";
  return queued > 0 ? `${queued} queued` : "synced";
}

// This screen carries no navigation on purpose, so a phone paired as a camera by
// mistake has no other way back to the sign-in screen. Reloading is what drops
// the device session, and the page teardown releases the camera with it.
async function signOut() {
  await supabase().auth.signOut();
  window.location.reload();
}

function SignOutFooter() {
  const [confirming, setConfirming] = useState(false);

  return (
    <footer className="row">
      {confirming ? (
        <div className="banner banner--warn">
          <span>This phone will stop counting and return to the sign-in screen.</span>
          <button type="button" className="btn btn--danger" onClick={() => void signOut()}>
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
