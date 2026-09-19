import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../lib/errorMessage";
import { supabase } from "../lib/supabaseClient";

// This device becomes a camera: it invents a secret, shows it as a QR, and
// waits. Nothing exists server-side until someone who may manage cameras scans
// it in the management hub and claims it into a unit; then redeem_pairing()
// hands this browser its one-time login token and it signs in as the newly
// created machine. No signup, no account, no typing.
function makeCode(): string {
  return (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "");
}

export default function Pair() {
  const codeRef = useRef<string>(makeCode());
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState<"waiting" | "signing-in">("waiting");
  const [error, setError] = useState<string | null>(null);

  // A LINK, not a bare code. A bare code only the in-app scanner understands
  // means a phone's own camera app reads the QR, shows 64 characters of hex and
  // offers nothing -- which is exactly how this screen stopped working. The
  // link lands a signed-in manager on Cameras with the claim already filled in;
  // to anyone else it is a page that asks them to sign in, and the code alone
  // grants nothing without someone who may manage cameras at a unit.
  useEffect(() => {
    if (canvasRef.current) {
      const claimUrl = `${window.location.origin}/org/cameras#pair=${codeRef.current}`;
      void QRCode.toCanvas(canvasRef.current, claimUrl, { width: 260, margin: 1 });
    }
  }, []);

  useEffect(() => {
    let active = true;
    const timer = setInterval(async () => {
      if (!active) return;
      try {
        const { data, error } = await supabase().rpc("redeem_pairing", {
          code: codeRef.current,
        });
        if (error || !data) return; // not claimed yet - keep waiting
        setStatus("signing-in");
        clearInterval(timer);
        const verify = await supabase().auth.verifyOtp({
          type: "magiclink",
          token_hash: data as string,
        });
        if (verify.error) throw verify.error;
        window.location.replace("/");
      } catch (e: unknown) {
        setError(errorMessage(e));
      }
    }, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="wrap wrap--narrow">
      <div className="stack">
        <h1 className="h1">Pair this camera</h1>
        <p className="muted">
          Ask a manager to scan this code from Cameras in the management hub, on the unit this
          camera stands in. This screen switches to the camera view by itself once they do.
        </p>

        {error ? (
          <div className="banner banner--crit" role="alert">
            {error}
          </div>
        ) : null}

        <div className="card qr">
          <canvas ref={canvasRef} />
        </div>

        <div className="row">
          <span className="spinner" />
          <span className="muted">
            {status === "waiting" ? "Waiting for the owner…" : "Signing in…"}
          </span>
        </div>
      </div>
    </div>
  );
}
