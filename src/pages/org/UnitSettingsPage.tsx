import { useQuery } from "@tanstack/react-query";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import { Card, CardTitle } from "../../components/ui/Card";
import { ErrorState } from "../../components/ui/EmptyState";
import { Pill } from "../../components/ui/Pill";
import { ListSkeleton } from "../../components/ui/Skeleton";
import { errorMessage } from "../../lib/errorMessage";
import { useI18n } from "../../lib/i18n";
import { getMyCapabilityReach } from "../../services/capabilities";
import { type CapabilityKey, findNode, getOrgTree } from "../../services/nodes";

// Display-only formatting for a capability key like "assign_work_down" --
// "Assign work down". Not a translation: fifteen capability keys sharing one
// vocabulary don't earn fifteen i18n rows, and this list is read here and
// nowhere else.
function humanize(key: CapabilityKey): string {
  return key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

// What a unit's settings still are once join codes and geofences went with
// the retail app: what this unit is called, and what it has explicitly been
// granted. Renaming it, moving it, or granting a new capability happens on
// the organisation chart, which owns those writes -- this page reads them.
export function UnitSettingsPage(): JSX.Element {
  const { t } = useI18n();
  const { nodeId } = useParams<{ nodeId: string }>();

  const reach = useQuery({ queryKey: ["org", "reach"], queryFn: getMyCapabilityReach });
  const isAdmin = reach.data?.isAdmin === true;

  const tree = useQuery({
    queryKey: ["org", "tree"],
    queryFn: getOrgTree,
    enabled: isAdmin,
  });

  if (reach.isLoading || (isAdmin && tree.isLoading)) {
    return <ListSkeleton rows={3} label={t("common.loading")} />;
  }
  if (!isAdmin) {
    return <ErrorState message={t("common.access_denied")} />;
  }
  if (tree.isError) {
    return <ErrorState message={errorMessage(tree.error, t("orgtree.load_failed"))} />;
  }

  const node = findNode(tree.data ?? [], nodeId);
  if (!node) {
    return <ErrorState message={t("orgtree.node_not_found")} />;
  }

  return (
    <div className="space-y-6">
      <div>
        <Link
          to={`/org/node/${nodeId}`}
          className="inline-flex min-h-11 items-center text-sm text-accent-text hover:underline"
        >
          {t("unit.back_to_node")}
        </Link>
        <h1 className="mt-2 font-display text-2xl font-bold text-ink">{t("unitsettings.title")}</h1>
      </div>

      <Card>
        <CardTitle>{t("unitsettings.identity_title")}</CardTitle>
        <dl className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-xs text-ink-faint">{t("unitsettings.name_label")}</dt>
            <dd className="text-sm text-ink">{node.name}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-faint">{t("unitsettings.name_en_label")}</dt>
            <dd className="text-sm text-ink">{node.name_en ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-faint">{t("orgtree.nature")}</dt>
            <dd className="text-sm text-ink">
              {node.nature_set_here ?? t("orgtree.nature_inherit")}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-faint">{t("common.status")}</dt>
            <dd className="text-sm text-ink">
              {node.active ? (
                <Pill tone="success">{t("unitsettings.active")}</Pill>
              ) : (
                <Pill tone="danger">{t("orgtree.inactive")}</Pill>
              )}
            </dd>
          </div>
        </dl>
        <p className="mt-4 text-xs text-ink-muted">{t("unitsettings.rename_hint")}</p>
      </Card>

      <Card>
        <CardTitle>{t("unitsettings.capabilities_title")}</CardTitle>
        {node.capabilities.length === 0 ? (
          <p className="text-sm text-ink-muted">{t("unitsettings.capabilities_none")}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {node.capabilities.map((key) => (
              <Pill key={key} tone="accent">
                {humanize(key)}
              </Pill>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <CardTitle>{t("unitsettings.cameras_title")}</CardTitle>
        <p className="text-sm text-ink-muted">{t("unitsettings.cameras_hint")}</p>
        <div className="mt-4">
          <Link
            to={`/org/node/${nodeId}/cameras`}
            className="text-sm font-medium text-accent-text hover:underline"
          >
            {t("unit.view_cameras")}
          </Link>
        </div>
      </Card>
    </div>
  );
}
