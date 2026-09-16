import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../lib/errorMessage";
import { supabase } from "../lib/supabaseClient";

// This device becomes a camera: it invents a secret, shows it as a QR, and
// waits. Nothing exists server-side until an ADMIN scans the QR and claims it;
// then redeem_pairing() hands this browser its one-time login token and it
// signs in as the newly created machine. No signup, no account, no typing.
function makeCode(): string {
  return (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "");
}

export default function Pair() {
  const codeRef = useRef<string>(makeCode());
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState<"waiting" | "signing-in">("waiting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const claimUrl = `${window.location.origin}/claim#${codeRef.current}`;
    if (canvasRef.current) {
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
    <div className="wrap">
      <div className="stack">
        <h1 className="h1">Pair this camera</h1>
        <p className="muted">
          Ask the owner to scan this code with their signed-in phone. This screen switches to the
          camera view by itself once approved.
        </p>

        {error ? (
          <div className="banner banner--crit" role="alert">
            {error}
          </div>
        ) : null}

        <div className="card">
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
