import jsQR from "jsqr";
import { type JSX, useEffect, useRef, useState } from "react";
import { errorMessage } from "../../lib/errorMessage";
import { useT } from "../../lib/i18n";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";

// A pairing QR carries a link ending in #pair=<code> so a phone's own camera
// app can follow it. Either that link or a bare code is accepted here: what
// this needs is the code, and both forms carry it.
export function readPairingCode(scanned: string): string | null {
  const text = scanned.trim();
  const marker = "#pair=";
  const at = text.indexOf(marker);
  const code = at === -1 ? text : text.slice(at + marker.length);
  return /^[0-9a-f]{32,}$/.test(code) ? code : null;
}

const SCAN_INTERVAL_MS = 250;
const SCAN_WIDTH = 480;

// Point this phone at the QR a waiting camera is showing. jsQR decodes pure
// pixels, so this works on every browser rather than only the ones shipping
// BarcodeDetector.
export function PairingCodeScanner({
  onCode,
  disabled,
}: {
  onCode: (code: string) => void;
  disabled?: boolean;
}): JSX.Element {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The stream is stopped on unmount as well as on a hit: a dialog closed with
  // the scanner running would otherwise leave the camera light on.
  useEffect(() => {
    return () => {
      const video = videoRef.current;
      const stream = video?.srcObject as MediaStream | null;
      for (const track of stream?.getTracks() ?? []) track.stop();
    };
  }, []);

  useEffect(() => {
    if (!running) return;
    let active = true;
    const timer = setInterval(() => {
      if (!active) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.videoWidth === 0) return;
      const w = SCAN_WIDTH;
      const h = Math.max(1, Math.round((video.videoHeight / video.videoWidth) * w));
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, w, h);
      const hit = jsQR(ctx.getImageData(0, 0, w, h).data, w, h);
      if (!hit) return;
      // Anything that is not a pairing code is another QR in the frame, not an
      // error worth showing -- keep looking.
      const code = readPairingCode(hit.data);
      if (!code) return;
      active = false;
      const stream = video.srcObject as MediaStream | null;
      for (const track of stream?.getTracks() ?? []) track.stop();
      setRunning(false);
      onCode(code);
    }, SCAN_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [running, onCode]);

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
      setError(t("pair.scan_failed", { reason: errorMessage(e) }));
    }
  }

  return (
    <div className="space-y-2">
      {error && <Alert variant="error">{error}</Alert>}
      {running ? (
        <div className="overflow-hidden rounded-md bg-black">
          {/* biome-ignore lint/a11y/useMediaCaption: a live camera preview has no audio track to caption */}
          <video ref={videoRef} playsInline muted className="w-full" />
        </div>
      ) : (
        <Button type="button" variant="secondary" onClick={start} disabled={disabled}>
          {t("pair.scan_start")}
        </Button>
      )}
      <canvas ref={canvasRef} hidden />
    </div>
  );
}
