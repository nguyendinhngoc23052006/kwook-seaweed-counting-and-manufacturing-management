import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { useParams } from "react-router-dom";
import { AttendanceConfigDialog } from "../../components/org/AttendanceConfigDialog";
import { CreateCameraDeviceDialog } from "../../components/org/CreateCameraDeviceDialog";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";
import { Empty, ErrorState } from "../../components/ui/EmptyState";
import { Pill } from "../../components/ui/Pill";
import { ListSkeleton } from "../../components/ui/Skeleton";
import { errorMessage } from "../../lib/errorMessage";
import { useT } from "../../lib/i18n";
import { listCameraDevices, revokeCameraDevice } from "../../services/cameras";
import { capabilityReaches, getMyCapabilityReach } from "../../services/capabilities";
import type { CameraDevice } from "../../types/camera";

function health(lastSeen: string | null): {
  label: string;
  tone: "success" | "warning" | "danger";
} {
  if (!lastSeen) return { label: "never_seen", tone: "danger" };
  const minutes = (Date.now() - new Date(lastSeen).getTime()) / 60_000;
  if (minutes > 10) return { label: "down", tone: "danger" };
  if (minutes > 2) return { label: "stale", tone: "warning" };
  return { label: "live", tone: "success" };
}

function DeviceRow({
  d,
  canManage,
  onRevoke,
  revoking,
  onConfigure,
  t,
}: {
  d: CameraDevice;
  canManage: boolean;
  onRevoke: (id: string) => void;
  revoking: boolean;
  onConfigure?: (d: CameraDevice) => void;
  t: ReturnType<typeof useT>;
}): JSX.Element {
  const h = health(d.last_seen_at);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-hairline bg-surface-raised p-3">
      <div>
        <div className="font-medium text-ink">{d.name}</div>
        <div className="text-xs text-ink-faint">{t(`device.role_${d.role}`)}</div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {d.revoked_at ? (
          <Pill tone="danger">{t("device.admin_revoked")}</Pill>
        ) : (
          <Pill tone={h.tone}>{t(`device.health_${h.label}`)}</Pill>
        )}
        {canManage &&
          !d.revoked_at &&
          (d.role === "check_in" || d.role === "check_out") &&
          onConfigure && (
            <Button
              size="sm"
              variant="ghost"
              className="whitespace-nowrap"
              onClick={() => onConfigure(d)}
            >
              {t("device.attendance_settings")}
            </Button>
          )}
        {canManage && !d.revoked_at && (
          <Button
            size="sm"
            variant="danger"
            className="whitespace-nowrap"
            disabled={revoking}
            onClick={() => onRevoke(d.id)}
          >
            {t("device.admin_revoke")}
          </Button>
        )}
      </div>
    </div>
  );
}

// Revoked devices are done, not active inventory -- same collapsed-by-default
// shape as CapabilityHistoryDisclosure (NodeCapabilityPanel.tsx): the count
// lives in the label, and there is nothing async to fetch since the page
// already holds every row for this node.
function RevokedDevicesDisclosure({
  devices,
  t,
}: {
  devices: CameraDevice[];
  t: ReturnType<typeof useT>;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (devices.length === 0) return null;

  return (
    <div className="border-t border-hairline pt-4">
      <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? t("device.hide_revoked") : t("device.show_revoked", { count: devices.length })}
      </Button>
      {open && (
        <div className="mt-2 space-y-2">
          {devices.map((d) => (
            <DeviceRow
              key={d.id}
              d={d}
              canManage={false}
              onRevoke={() => {}}
              revoking={false}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Node-scoped, like camera_devices.sql's own RLS: this node's own devices,
// gated by manage_camera_devices (create/revoke) or view_camera_data (read
// only, which also covers export) reaching this node.
export function CamerasPage(): JSX.Element {
  const { nodeId } = useParams<{ nodeId: string }>();
  const t = useT();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [configDevice, setConfigDevice] = useState<CameraDevice | null>(null);

  const reach = useQuery({
    queryKey: ["org", "reach"],
    queryFn: getMyCapabilityReach,
  });
  const canManage =
    Boolean(nodeId) && capabilityReaches(reach.data, "manage_camera_devices", nodeId ?? "");
  const canView =
    Boolean(nodeId) &&
    (canManage || capabilityReaches(reach.data, "view_camera_data", nodeId ?? ""));

  const devices = useQuery({
    queryKey: ["cameras", "devices", nodeId ?? null],
    queryFn: () => listCameraDevices(nodeId ?? ""),
    enabled: canView && Boolean(nodeId),
  });

  const revoke = useMutation({
    mutationFn: (deviceId: string) => revokeCameraDevice(deviceId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["cameras", "devices", nodeId ?? null],
      }),
  });

  if (reach.isLoading) {
    return <ListSkeleton rows={3} label={t("common.loading")} />;
  }
  if (!canView) {
    return <Empty title={t("device.not_yours")} description={t("device.not_yours_hint")} />;
  }
  if (devices.isError) {
    return (
      <ErrorState
        message={errorMessage(devices.error, t("device.load_failed"))}
        action={<Button onClick={() => devices.refetch()}>{t("common.retry")}</Button>}
      />
    );
  }

  const rows: CameraDevice[] = devices.data ?? [];
  const liveRows = rows.filter((d) => !d.revoked_at);
  const revokedRows = rows.filter((d) => d.revoked_at);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-2xl font-bold text-ink">{t("device.admin_title")}</h1>
        {canManage && (
          <Button onClick={() => setCreateOpen(true)}>{t("device.admin_create")}</Button>
        )}
      </div>

      {devices.isLoading ? (
        <ListSkeleton rows={3} label={t("device.loading")} />
      ) : rows.length === 0 ? (
        <Empty title={t("device.admin_no_devices")} />
      ) : (
        <>
          {liveRows.length === 0 ? (
            <Empty title={t("device.admin_no_live_devices")} />
          ) : (
            <div className="space-y-2">
              {liveRows.map((d) => (
                <DeviceRow
                  key={d.id}
                  d={d}
                  canManage={canManage}
                  onRevoke={(id) => revoke.mutate(id)}
                  revoking={revoke.isPending}
                  onConfigure={(device) => setConfigDevice(device)}
                  t={t}
                />
              ))}
            </div>
          )}
          <RevokedDevicesDisclosure devices={revokedRows} t={t} />
        </>
      )}

      {revoke.isError && (
        <Alert variant="error">{errorMessage(revoke.error, t("device.revoke_failed"))}</Alert>
      )}

      {nodeId && (
        <CreateCameraDeviceDialog
          nodeId={nodeId}
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onCreated={() =>
            queryClient.invalidateQueries({
              queryKey: ["cameras", "devices", nodeId],
            })
          }
        />
      )}

      {configDevice !== null && (
        <AttendanceConfigDialog
          device={configDevice}
          open={configDevice !== null}
          onClose={() => setConfigDevice(null)}
          onSaved={() =>
            queryClient.invalidateQueries({
              queryKey: ["cameras", "devices", nodeId ?? null],
            })
          }
        />
      )}
    </div>
  );
}
