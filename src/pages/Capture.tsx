import { useCallback, useEffect, useRef, useState } from "react";
import { flush, outbox } from "../lib/outbox";
import { type DeviceConfig, loadDeviceConfig, type Profile } from "../lib/session";
import { supabase } from "../lib/supabaseClient";
import { connectedComponents, filterByArea } from "../vision/connectedComponents";
import { LineCounter } from "../vision/lineCounter";
import { binarize, otsu, toGray } from "../vision/otsu";

const ALGORITHM_VERSION = "line-counter@1";
const PROC_WIDTH = 320;
const MIN_BLOB_AREA = 30;
const MAX_BLOB_AREA = 20000;

// lib.dom declares requestVideoFrameCallback as required; Safari on older iOS
// does not ship it, so it is probed at the call site instead of in the type.
type FrameScheduler = { requestVideoFrameCallback?: (cb: () => void) => number };

export default function Capture({ profile }: { profile: Profile }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const counterRef = useRef<LineCounter | null>(null);
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

  useEffect(() => {
    loadDeviceConfig(profile.id)
      .then(setConfig)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [profile.id]);

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
    const { threshold } = otsu(gray);
    const mask = binarize(gray, threshold, true);
    const blobs = filterByArea(connectedComponents(mask, w, h), MIN_BLOB_AREA, MAX_BLOB_AREA);

    const newly = counter.update(blobs);
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
  }, [config, persistMinute]);

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
        lineY: 60,
        beltDy: 8,
        gateRadius: 24,
        minTrackAge: 3,
        maxMissed: 2,
      });
      await navigator.wakeLock?.request("screen").catch(() => undefined);
      setRunning(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (error)
    return (
      <div className="wrap">
        <div className="card crit">{error}</div>
      </div>
    );
  if (!config) return <div className="wrap">Loading device…</div>;
  if (config.revoked_at) {
    return (
      <div className="wrap">
        <div className="card crit">This device has been unpaired. Ask an admin to re-pair it.</div>
      </div>
    );
  }

  return (
    <div className="wrap">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <div className="label">Device</div>
          <strong>{config.name}</strong> · <span className="pill">{config.role}</span>
        </div>
        <span className={queued > 0 ? "pill warn" : "pill ok"}>
          {queued > 0 ? `${queued} queued` : "synced"}
        </span>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="label">Counted this session</div>
        <div className="figure">{total}</div>
        {!running ? (
          <button type="button" onClick={start}>
            Start counting
          </button>
        ) : null}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <video ref={videoRef} playsInline muted />
        <canvas ref={canvasRef} style={{ display: "none" }} />
      </div>
    </div>
  );
}
