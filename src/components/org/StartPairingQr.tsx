import QRCode from "qrcode";
import { type JSX, useEffect, useRef } from "react";
import { useT } from "../../lib/i18n";

// Getting a phone to /pair used to mean typing a URL on it, which is exactly
// the work the rules say to design out -- and nothing in the app linked there,
// so you had to know the path existed. This is the other half of the scan:
// point the phone at this, it opens /pair, and it shows its own QR back.
export function StartPairingQr(): JSX.Element {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pairUrl = `${window.location.origin}/pair`;

  useEffect(() => {
    if (canvasRef.current) {
      void QRCode.toCanvas(canvasRef.current, pairUrl, { width: 160, margin: 1 });
    }
  }, [pairUrl]);

  return (
    <div className="flex items-center gap-3 rounded-lg border border-hairline bg-surface-muted p-3">
      <canvas ref={canvasRef} className="shrink-0 rounded bg-white" />
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">{t("pair.start_title")}</p>
        <p className="mt-1 text-xs text-ink-faint">{t("pair.start_hint")}</p>
        <p className="mt-1 break-all font-mono text-xs text-ink-faint">{pairUrl}</p>
      </div>
    </div>
  );
}
