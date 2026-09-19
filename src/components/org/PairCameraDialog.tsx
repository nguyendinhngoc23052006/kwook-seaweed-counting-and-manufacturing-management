import { useMutation } from "@tanstack/react-query";
import { type JSX, useCallback, useState } from "react";
import { errorMessage } from "../../lib/errorMessage";
import { useT } from "../../lib/i18n";
import { claimCameraPairing } from "../../services/cameras";
import type { CameraDeviceRole } from "../../types/camera";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Input, Label } from "../ui/Input";
import { Select } from "../ui/Select";
import { PairingCodeScanner } from "./PairingCodeScanner";

const ROLES: CameraDeviceRole[] = [
  "counting",
  "check_in",
  "check_out",
  "compliance",
  "provisioning",
  "overview",
];

// A camera comes into existence by being CLAIMED, never by being issued
// credentials. The phone invents a secret and shows it as a QR; this dialog
// scans it and tells the server which node the camera is standing in. Nothing
// exists server-side until that claim lands, so an unclaimed phone is a local
// secret and a spinner -- account spam is structurally impossible.
export function PairCameraDialog({
  nodeId,
  open,
  onClose,
  onPaired,
  initialCode,
}: {
  nodeId: string;
  open: boolean;
  onClose: () => void;
  onPaired: () => void;
  // Set when the manager arrived here by following a scanned pairing QR, so
  // the code is already in hand and there is nothing to scan again.
  initialCode?: string | null;
}): JSX.Element {
  const t = useT();
  const [name, setName] = useState("");
  const [role, setRole] = useState<CameraDeviceRole>("counting");
  const [code, setCode] = useState(initialCode ?? "");
  const [done, setDone] = useState(false);

  const pair = useMutation({
    mutationFn: () => claimCameraPairing({ nodeId, name: name.trim(), role, code: code.trim() }),
    onSuccess: () => {
      setDone(true);
      onPaired();
    },
  });

  // Identity-stable so the scanner's effect does not tear down and restart the
  // camera on every keystroke in the name field.
  const handleCode = useCallback((scanned: string) => setCode(scanned), []);

  function handleClose() {
    setName("");
    setRole("counting");
    setCode("");
    setDone(false);
    pair.reset();
    onClose();
  }

  return (
    <Dialog open={open} onClose={handleClose} title={t("pair.dialog_title")}>
      {done ? (
        <div className="space-y-3">
          <Alert variant="success">{t("pair.done", { name: name.trim() })}</Alert>
          <p className="text-sm text-ink-muted">{t("pair.done_hint")}</p>
          <Button onClick={handleClose} className="w-full">
            {t("common.done")}
          </Button>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && code.trim()) pair.mutate();
          }}
        >
          <p className="text-sm text-ink-muted">{t("pair.dialog_hint")}</p>

          <div>
            <Label htmlFor="pair-camera-name">{t("device.create_name")}</Label>
            <Input
              id="pair-camera-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              disabled={pair.isPending}
            />
          </div>

          <div>
            <Label htmlFor="pair-camera-role">{t("device.create_role")}</Label>
            <Select
              value={role}
              onChange={setRole}
              options={ROLES.map((r) => ({ value: r, label: t(`device.role_${r}`) }))}
              disabled={pair.isPending}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="pair-camera-code">{t("pair.code_label")}</Label>
            <PairingCodeScanner onCode={handleCode} disabled={pair.isPending} />
            <Input
              id="pair-camera-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={t("pair.code_placeholder")}
              required
              disabled={pair.isPending}
              className="font-mono text-xs"
            />
          </div>

          {pair.isError && (
            <Alert variant="error">{errorMessage(pair.error, t("pair.failed"))}</Alert>
          )}

          <Button
            type="submit"
            disabled={pair.isPending || !name.trim() || !code.trim()}
            className="w-full"
          >
            {pair.isPending ? t("pair.busy") : t("pair.submit")}
          </Button>
        </form>
      )}
    </Dialog>
  );
}
