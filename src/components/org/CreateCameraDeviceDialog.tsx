import { useMutation } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { errorMessage } from "../../lib/errorMessage";
import { useT } from "../../lib/i18n";
import { createCameraDevice } from "../../services/cameras";
import type { CameraDeviceRole, CreatedCameraDevice } from "../../types/camera";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Input, Label } from "../ui/Input";
import { TouchSelect } from "./TouchSelect";

const ROLES: CameraDeviceRole[] = ["counting", "compliance", "provisioning", "overview"];

// The generated credential is shown exactly once, here, and never persisted
// anywhere in plaintext -- not in this component's state after the dialog
// closes, not in a table, not in a log.
export function CreateCameraDeviceDialog({
  nodeId,
  open,
  onClose,
  onCreated,
}: {
  nodeId: string;
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}): JSX.Element {
  const t = useT();
  const [name, setName] = useState("");
  const [role, setRole] = useState<CameraDeviceRole>("counting");
  const [created, setCreated] = useState<CreatedCameraDevice | null>(null);

  const create = useMutation({
    mutationFn: () => createCameraDevice({ nodeId, name: name.trim(), role }),
    onSuccess: (result) => {
      setCreated(result);
      onCreated();
    },
  });

  function handleClose() {
    setName("");
    setRole("counting");
    setCreated(null);
    create.reset();
    onClose();
  }

  return (
    <Dialog open={open} onClose={handleClose} title={t("device.create_dialog_title")}>
      {created ? (
        <div className="space-y-3">
          <Alert variant="warning">{t("device.create_credential_warning")}</Alert>
          <div>
            <div className="text-xs text-ink-faint">{t("device.create_email")}</div>
            <div className="select-all rounded-md bg-surface-muted p-2 font-mono text-sm">
              {created.email}
            </div>
          </div>
          <div>
            <div className="text-xs text-ink-faint">{t("device.create_password")}</div>
            <div className="select-all rounded-md bg-surface-muted p-2 font-mono text-sm">
              {created.password}
            </div>
          </div>
          <Button onClick={handleClose} className="w-full">
            {t("device.create_done")}
          </Button>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <div>
            <Label htmlFor="camera-device-name">{t("device.create_name")}</Label>
            <Input
              id="camera-device-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              disabled={create.isPending}
            />
          </div>
          <div>
            <Label htmlFor="camera-device-role">{t("device.create_role")}</Label>
            <TouchSelect
              value={role}
              onChange={setRole}
              options={ROLES.map((r) => ({
                value: r,
                label: t(`device.role_${r}`),
              }))}
              disabled={create.isPending}
            />
          </div>
          {create.isError && (
            <Alert variant="error">{errorMessage(create.error, t("device.create_error"))}</Alert>
          )}
          <Button type="submit" disabled={create.isPending || !name.trim()} className="w-full">
            {create.isPending ? t("device.create_busy") : t("device.create_button")}
          </Button>
        </form>
      )}
    </Dialog>
  );
}
