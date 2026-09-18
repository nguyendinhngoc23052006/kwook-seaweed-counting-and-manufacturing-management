import { useQuery } from "@tanstack/react-query";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import { Card, CardTitle } from "../../components/ui/Card";
import { Empty, ErrorState } from "../../components/ui/EmptyState";
import { Pill } from "../../components/ui/Pill";
import { ListSkeleton } from "../../components/ui/Skeleton";
import { errorMessage } from "../../lib/errorMessage";
import { useI18n } from "../../lib/i18n";
import { listCameraDevices } from "../../services/cameras";
import { capabilityReaches, getMyCapabilityReach } from "../../services/capabilities";
import { findNode, getOrgTree, type OrgTreeNode } from "../../services/nodes";
import type { CameraDevice } from "../../types/camera";

function nodeLabel(node: OrgTreeNode, locale: string): string {
  return locale === "en" ? (node.name_en ?? node.name) : node.name;
}

// Mirrors CamerasPage's own health() read, just collapsed to the one bit this
// card needs: is this device still reporting, or does it want attention.
function isCameraDown(device: CameraDevice): boolean {
  if (device.revoked_at) return false;
  if (!device.last_seen_at) return true;
  const minutes = (Date.now() - new Date(device.last_seen_at).getTime()) / 60_000;
  return minutes > 2;
}

// What a unit still needs a dashboard for once its structure lives on the
// organisation chart: how fully it is staffed, and whether its cameras are
// still reporting. Both are read from data other screens already own -- the
// org tree snapshot and this unit's device list -- nothing new is written
// here, only summarised with a way in to each area.
export function UnitPage(): JSX.Element {
  const { t, locale } = useI18n();
  const { nodeId } = useParams<{ nodeId: string }>();

  const reach = useQuery({ queryKey: ["org", "reach"], queryFn: getMyCapabilityReach });
  const isAdmin = reach.data?.isAdmin === true;

  const tree = useQuery({
    queryKey: ["org", "tree"],
    queryFn: getOrgTree,
    enabled: isAdmin,
  });

  const canViewCameras =
    Boolean(nodeId) &&
    (isAdmin ||
      capabilityReaches(reach.data, "view_camera_data", nodeId ?? "") ||
      capabilityReaches(reach.data, "manage_camera_devices", nodeId ?? ""));

  const devices = useQuery({
    queryKey: ["cameras", "devices", nodeId ?? null],
    queryFn: () => listCameraDevices(nodeId ?? ""),
    enabled: canViewCameras && Boolean(nodeId),
  });

  if (reach.isLoading || (isAdmin && tree.isLoading)) {
    return <ListSkeleton rows={3} label={t("common.loading")} />;
  }
  if (!isAdmin) {
    return <Empty title={t("unit.not_yours")} description={t("unit.not_yours_hint")} />;
  }
  if (tree.isError) {
    return <ErrorState message={errorMessage(tree.error, t("orgtree.load_failed"))} />;
  }

  const node = findNode(tree.data ?? [], nodeId);
  if (!node) {
    return <ErrorState message={t("orgtree.node_not_found")} />;
  }

  const staffed = node.seats.filter((seat) => seat.person_id).length;
  const vacant = node.seats.length - staffed;
  const rows: CameraDevice[] = devices.data ?? [];
  const down = rows.filter(isCameraDown).length;

  return (
    <div className="space-y-6">
      <h1 className="font-display text-2xl font-bold text-ink">{nodeLabel(node, locale)}</h1>

      <Card>
        <div className="flex items-center justify-between">
          <CardTitle>{t("unit.staffing_card")}</CardTitle>
          <div className="text-2xl font-semibold text-ink">
            {staffed}/{node.seats.length}
          </div>
        </div>
        {node.seats.length === 0 ? (
          <p className="text-sm text-ink-muted">{t("orgtree.no_seats")}</p>
        ) : (
          <p className="text-sm text-ink-muted">
            {vacant > 0 ? t("unit.seats_vacant_n", { n: vacant }) : t("unit.seats_full")}
          </p>
        )}
        <div className="mt-4">
          <Link
            to={`/org/node/${nodeId}/people`}
            className="text-sm font-medium text-accent-text hover:underline"
          >
            {t("unit.view_people")}
          </Link>
        </div>
      </Card>

      {canViewCameras && (
        <Card>
          <div className="flex items-center justify-between">
            <CardTitle>{t("unit.cameras_card")}</CardTitle>
            {devices.isSuccess && down > 0 && (
              <Pill tone="danger">{t("unit.cameras_down_n", { n: down })}</Pill>
            )}
          </div>
          {devices.isLoading ? (
            <p className="text-sm text-ink-muted">{t("common.loading")}</p>
          ) : devices.isError ? (
            <p className="text-sm text-danger-text">
              {errorMessage(devices.error, t("device.load_failed"))}
            </p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-ink-muted">{t("device.admin_no_devices")}</p>
          ) : down === 0 ? (
            <p className="text-sm text-ink-muted">{t("unit.cameras_all_ok")}</p>
          ) : null}
          <div className="mt-4">
            <Link
              to={`/org/node/${nodeId}/cameras`}
              className="text-sm font-medium text-accent-text hover:underline"
            >
              {t("unit.view_cameras")}
            </Link>
          </div>
        </Card>
      )}
    </div>
  );
}
