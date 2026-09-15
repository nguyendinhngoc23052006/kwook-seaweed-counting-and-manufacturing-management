import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../lib/errorMessage";
import { connectedComponents, filterBlobs } from "../vision/connectedComponents";
import { LineCounter } from "../vision/lineCounter";
import { close, open } from "../vision/morphology";
import { binarize, otsu, toGray } from "../vision/otsu";
import type { Blob } from "../vision/types";

const PROC_WIDTH = 320;

type FrameScheduler = { requestVideoFrameCallback?: (cb: () => void) => number };

interface Settings {
  linePercent: number;
  minArea: number;
  darkOnLight: boolean;
  showMask: boolean;
}

export default function Demo() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const procRef = useRef<HTMLCanvasElement | null>(null);
  const maskRef = useRef<HTMLCanvasElement | null>(null);
  const counterRef = useRef<LineCounter | null>(null);
  const frameTimes = useRef<number[]>([]);

  // Read inside the rAF loop, which must not restart when a slider moves.
  const settingsRef = useRef<Settings>({
    linePercent: 50,
    minArea: 150,
    darkOnLight: true,
    showMask: false,
  });

  const [settings, setSettings] = useState<Settings>(settingsRef.current);
  const [running, setRunning] = useState(false);
  const [count, setCount] = useState(0);
  const [created, setCreated] = useState(0);
  const [fps, setFps] = useState(0);
  const [error, setError] = useState<string | null>(null);

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    const next = { ...settingsRef.current, [key]: value };
    settingsRef.current = next;
    setSettings(next);
  }

  const drawOverlay = useCallback(
    (blobs: Blob[], mask: Uint8Array, w: number, h: number, lineY: number) => {
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

      if (settingsRef.current.showMask) {
        const maskCanvas = maskRef.current;
        if (maskCanvas) {
          maskCanvas.width = w;
          maskCanvas.height = h;
          const mctx = maskCanvas.getContext("2d");
          if (mctx) {
            const img = mctx.createImageData(w, h);
            for (let i = 0; i < mask.length; i++) {
              const on = mask[i] === 1;
              img.data[i * 4] = 0;
              img.data[i * 4 + 1] = on ? 255 : 0;
              img.data[i * 4 + 2] = on ? 200 : 0;
              img.data[i * 4 + 3] = on ? 110 : 0;
            }
            mctx.putImageData(img, 0, 0);
            ctx.drawImage(maskCanvas, 0, 0, overlay.width, overlay.height);
          }
        }
      }

      // Detected blobs.
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#4e9fd4";
      ctx.font = "600 12px ui-sans-serif, system-ui, sans-serif";
      for (const b of blobs) {
        ctx.strokeRect(b.minX * sx, b.minY * sy, (b.maxX - b.minX) * sx, (b.maxY - b.minY) * sy);
      }

      // Tracks: filled once they have been counted.
      for (const t of counterRef.current?.activeTracks() ?? []) {
        ctx.beginPath();
        ctx.arc(t.cx * sx, t.cy * sy, 6, 0, Math.PI * 2);
        ctx.fillStyle = t.counted ? "#2e7d5b" : "#cf9134";
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.fillText(String(t.id), t.cx * sx + 9, t.cy * sy + 4);
      }

      // The counting line, drawn last so nothing hides it.
      const y = lineY * sy;
      ctx.strokeStyle = "#ff3b30";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(overlay.width, y);
      ctx.stroke();

      ctx.fillStyle = "#ff3b30";
      ctx.fillText("COUNT LINE  ▼ direction of travel", 8, y - 8);
    },
    [],
  );

  const processFrame = useCallback(() => {
    const video = videoRef.current;
    const proc = procRef.current;
    const counter = counterRef.current;
    if (!video || !proc || !counter || video.videoWidth === 0) return;

    const w = PROC_WIDTH;
    const h = Math.max(1, Math.round((video.videoHeight / video.videoWidth) * PROC_WIDTH));
    proc.width = w;
    proc.height = h;

    const ctx = proc.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, w, h);

    const s = settingsRef.current;
    const gray = toGray(ctx.getImageData(0, 0, w, h).data);
    const { threshold } = otsu(gray);
    const mask = close(open(binarize(gray, threshold, s.darkOnLight), w, h), w, h);
    // Same compactness gate as the operator page: reject sparse dark clutter
    // (fillRatio) on top of the size slider.
    const blobs = filterBlobs(connectedComponents(mask, w, h), {
      minArea: s.minArea,
      maxArea: w * h,
      minFill: 0.35,
    });

    const lineY = (s.linePercent / 100) * h;
    counter.setLineY(lineY);
    counter.update(blobs);

    const stats = counter.stats();
    setCount(stats.counted);
    setCreated(stats.created);

    const now = performance.now();
    frameTimes.current.push(now);
    while (frameTimes.current.length > 0 && now - (frameTimes.current[0] as number) > 1000) {
      frameTimes.current.shift();
    }
    setFps(frameTimes.current.length);

    drawOverlay(blobs, mask, w, h, lineY);
  }, [drawOverlay]);

  useEffect(() => {
    if (!running) return;
    let active = true;
    const loop = () => {
      if (!active) return;
      processFrame();
      const video = videoRef.current as (HTMLVideoElement & FrameScheduler) | null;
      if (video?.requestVideoFrameCallback) video.requestVideoFrameCallback(loop);
      else setTimeout(loop, 66);
    };
    loop();
    return () => {
      active = false;
    };
  }, [running, processFrame]);

  async function start() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 } },
        audio: false,
      });
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play();
      }
      counterRef.current = new LineCounter({
        lineY: 0,
        beltDy: 6,
        gateRadius: 40,
        minTrackAge: 2,
        maxMissed: 3,
      });
      setRunning(true);
    } catch (e: unknown) {
      setError(`${errorMessage(e)} — camera access needs HTTPS (or localhost) and permission.`);
    }
  }

  function reset() {
    counterRef.current?.reset();
    setCount(0);
    setCreated(0);
  }

  return (
    <div className="wrap">
      <h1 style={{ marginBottom: 4 }}>Line counter — live demo</h1>
      <p className="label" style={{ marginTop: 0 }}>
        Point the camera at the belt. Anything crossing the red line downward is counted once.
      </p>

      {error ? <div className="card crit">{error}</div> : null}

      <div className="row" style={{ gap: 24, marginBottom: 12 }}>
        <div>
          <div className="label">Counted</div>
          <div className="figure" style={{ color: "var(--ok)" }}>
            {count}
          </div>
        </div>
        <div>
          <div className="label">Tracks seen</div>
          <div className="figure">{created}</div>
        </div>
        <div>
          <div className="label">FPS</div>
          <div className="figure">{fps}</div>
        </div>
      </div>

      <div className="row" style={{ marginBottom: 12 }}>
        {!running ? (
          <button type="button" onClick={start}>
            Start camera
          </button>
        ) : (
          <button type="button" className="secondary" onClick={reset}>
            Reset count
          </button>
        )}
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ position: "relative", lineHeight: 0 }}>
          <video ref={videoRef} playsInline muted style={{ width: "100%", display: "block" }} />
          <canvas
            ref={overlayRef}
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
          />
        </div>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <div className="label">Line position — {settings.linePercent}%</div>
        <input
          id="linePercent"
          type="range"
          min="5"
          max="95"
          value={settings.linePercent}
          onChange={(e) => update("linePercent", Number(e.target.value))}
          style={{ width: "100%" }}
        />

        <div className="label" style={{ marginTop: 12 }}>
          Minimum blob size — {settings.minArea} px
        </div>
        <input
          id="minArea"
          type="range"
          min="20"
          max="2000"
          step="10"
          value={settings.minArea}
          onChange={(e) => update("minArea", Number(e.target.value))}
          style={{ width: "100%" }}
        />
        <p className="label" style={{ marginTop: 4 }}>
          Raise it until specks and glare stop being boxed; lower it if small leaves are missed.
        </p>

        <div className="row" style={{ marginTop: 12 }}>
          <label htmlFor="darkOnLight">
            <input
              id="darkOnLight"
              type="checkbox"
              checked={settings.darkOnLight}
              onChange={(e) => update("darkOnLight", e.target.checked)}
            />{" "}
            Dark objects on a light belt
          </label>
          <label htmlFor="showMask">
            <input
              id="showMask"
              type="checkbox"
              checked={settings.showMask}
              onChange={(e) => update("showMask", e.target.checked)}
            />{" "}
            Show what the detector sees
          </label>
        </div>
      </div>

      <canvas ref={procRef} hidden />
      <canvas ref={maskRef} hidden />
    </div>
  );
}
