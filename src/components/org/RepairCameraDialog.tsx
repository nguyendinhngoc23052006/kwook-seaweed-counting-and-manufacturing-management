import { useMutation } from "@tanstack/react-query";
import { type JSX, useCallback, useState } from "react";
import { errorMessage } from "../../lib/errorMessage";
import { useT } from "../../lib/i18n";
import { repairCameraPairing } from "../../services/cameras";
import type { CameraDevice } from "../../types/camera";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Input, Label } from "../ui/Input";
import { PairingCodeScanner } from "./PairingCodeScanner";
import { StartPairingQr } from "./StartPairingQr";

// Give an existing camera a new phone. Nothing about the camera changes -- not
// its name, its role, its station, nor a single row it has ever written. Only
// which handset is allowed to be it from now on.
export function RepairCameraDialog({
  device,
  open,
  onClose,
  onRepaired,
}: {
  device: CameraDevice;
  open: boolean;
  onClose: () => void;
  onRepaired: () => void;
}): JSX.Element {
  const t = useT();
  const [code, setCode] = useState("");
  const [done, setDone] = useState(false);

  const repair = useMutation({
    mutationFn: () => repairCameraPairing({ deviceId: device.id, code: code.trim() }),
    onSuccess: () => {
      setDone(true);
      onRepaired();
    },
  });

  const handleCode = useCallback((scanned: string) => setCode(scanned), []);

  function handleClose() {
    setCode("");
    setDone(false);
    repair.reset();
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title={t("repair.dialog_title", { name: device.name })}
    >
      {done ? (
        <div className="space-y-3">
          <Alert variant="success">{t("repair.done", { name: device.name })}</Alert>
          <p className="text-sm text-ink-muted">{t("repair.done_hint")}</p>
          <Button onClick={handleClose} className="w-full">
            {t("common.done")}
          </Button>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (code.trim()) repair.mutate();
          }}
        >
          <p className="text-sm text-ink-muted">{t("repair.dialog_hint")}</p>
          <StartPairingQr />

          <div className="space-y-2">
            <Label htmlFor="repair-camera-code">{t("pair.code_label")}</Label>
            <PairingCodeScanner onCode={handleCode} disabled={repair.isPending} />
            <Input
              id="repair-camera-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={t("pair.code_placeholder")}
              required
              disabled={repair.isPending}
              className="font-mono text-xs"
            />
          </div>

          {repair.isError && (
            <Alert variant="error">{errorMessage(repair.error, t("repair.failed"))}</Alert>
          )}

          <Button type="submit" disabled={repair.isPending || !code.trim()} className="w-full">
            {repair.isPending ? t("repair.busy") : t("repair.submit")}
          </Button>
        </form>
      )}
    </Dialog>
  );
}
