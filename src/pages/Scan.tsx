import jsQR from "jsqr";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../lib/errorMessage";
import type { Profile } from "../lib/session";

// In-app QR scanner for admins: point this phone at the QR a waiting camera
// shows, and it opens the /claim page for it. Same camera-to-canvas pipeline
// the vision core uses; jsQR decodes pure pixels, so it works on every
// browser (no BarcodeDetector dependency).
export default function Scan({ profile }: { profile: Profile }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!running) return;
    let active = true;
    const timer = setInterval(() => {
      if (!active) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.videoWidth === 0) return;
      const w = 480;
      const h = Math.max(1, Math.round((video.videoHeight / video.videoWidth) * w));
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, w, h);
      const img = ctx.getImageData(0, 0, w, h);
      const hit = jsQR(img.data, w, h);
      if (!hit) return;
      // Only pairing links from THIS site are followed; any other QR is noise.
      const marker = "/claim#";
      const at = hit.data.indexOf(marker);
      if (at === -1) return;
      active = false;
      window.location.href = `${window.location.origin}${hit.data.slice(at)}`;
    }, 250);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [running]);

  if (profile.role !== "owner") {
    return (
      <div className="wrap">
        <div className="empty">
          <h2 className="empty__title">Owner access required</h2>
          <p className="empty__body">
            Scanning a pairing code creates a camera account, so only an owner can do it.
          </p>
        </div>
      </div>
    );
  }

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
      setRunning(true);
    } catch (e: unknown) {
      setError(`${errorMessage(e)} — camera access needs HTTPS and permission.`);
    }
  }

  return (
    <div className="wrap">
      <div className="stack">
        <h1 className="h1">Scan a camera's QR</h1>
        <p className="muted">
          Point this phone at the QR shown on the device that wants to become a camera. The pairing
          form opens by itself.
        </p>

        {error ? (
          <div className="banner banner--crit" role="alert">
            {error}
          </div>
        ) : null}

        {!running ? (
          <button type="button" className="btn btn--primary btn--block" onClick={start}>
            Start scanning
          </button>
        ) : null}

        <div className="card card--flush stack">
          <video ref={videoRef} playsInline muted />
        </div>
        <canvas ref={canvasRef} hidden />
      </div>
    </div>
  );
}
