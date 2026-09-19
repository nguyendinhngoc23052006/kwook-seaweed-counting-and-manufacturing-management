import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { errorMessage } from "../../lib/errorMessage";
import { useT } from "../../lib/i18n";
import { listCameraStations, updateCameraDevice } from "../../services/cameras";
import type { CameraDevice, CameraDeviceRole } from "../../types/camera";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Input, Label } from "../ui/Input";
import { Select } from "../ui/Select";

const ROLES: CameraDeviceRole[] = [
  "check_in",
  "check_out",
  "counting",
  "compliance",
  "overview",
  "provisioning",
];

// A camera that moved to a different doorway used to keep reporting the old
// one: camera_devices had no write path of any kind, so the only "fix" was to
// revoke the device and pair a new one, starting its history over.
export function EditCameraDeviceDialog({
  open,
  onClose,
  device,
  nodeId,
}: {
  open: boolean;
  onClose: () => void;
  device: CameraDevice;
  nodeId: string;
}): JSX.Element | null {
  const t = useT();
  const queryClient = useQueryClient();
  const [name, setName] = useState(device.name);
  const [role, setRole] = useState<CameraDeviceRole>(device.role);
  const [stationId, setStationId] = useState(device.station_id ?? "");
  const [error, setError] = useState<string | null>(null);

  const stations = useQuery({
    queryKey: ["org", "camera-stations", nodeId],
    queryFn: () => listCameraStations(nodeId),
    enabled: open,
  });

  const save = useMutation({
    mutationFn: () =>
      updateCameraDevice({
        deviceId: device.id,
        name,
        role,
        // "" is the explicit detach; undefined would mean "leave it".
        stationId: stationId === "" ? null : stationId,
      }),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["cameras", "devices", nodeId] });
      onClose();
    },
    onError: (e) => setError(errorMessage(e, t("device.update_failed"))),
  });

  const changed =
    name.trim() !== device.name ||
    role !== device.role ||
    (stationId || null) !== (device.station_id ?? null);

  if (!open) return null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("device.edit_title", { name: device.name })}
      description={t("device.edit_hint")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={save.isPending}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={save.isPending || !changed || !name.trim()}
          >
            {save.isPending ? t("common.loading") : t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert variant="error">{error}</Alert>}

        <div>
          <Label htmlFor="camera-edit-name">{t("device.name")}</Label>
          <Input
            id="camera-edit-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={save.isPending}
          />
        </div>

        <div>
          <Label htmlFor="camera-edit-role">{t("device.role")}</Label>
          <Select
            id="camera-edit-role"
            value={role}
            onChange={(v) => setRole(v as CameraDeviceRole)}
            ariaLabel={t("device.role")}
            disabled={save.isPending}
            options={ROLES.map((r) => ({ value: r, label: t(`device.role_${r}`) }))}
          />
          {/* Rule 2: the function comes from the server, never the phone. The
              camera reads this on its next heartbeat and changes what it is. */}
          <p className="mt-1 text-xs text-muted-foreground">{t("device.role_hint")}</p>
        </div>

        <div>
          <Label htmlFor="camera-edit-station">{t("device.station")}</Label>
          <Select
            id="camera-edit-station"
            value={stationId}
            onChange={setStationId}
            ariaLabel={t("device.station")}
            disabled={save.isPending}
            options={[
              { value: "", label: t("device.no_station") },
              ...(stations.data ?? [])
                .filter((s) => s.active)
                .map((s) => ({ value: s.id, label: `${s.name} · ${s.line}` })),
            ]}
          />
          {(stations.data ?? []).length === 0 && !stations.isLoading && (
            <p className="mt-1 text-xs text-muted-foreground">{t("device.no_stations_yet")}</p>
          )}
        </div>
      </div>
    </Dialog>
  );
}
