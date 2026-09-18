import { useQuery } from "@tanstack/react-query";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import { Card } from "../../components/ui/Card";
import { Empty, ErrorState } from "../../components/ui/EmptyState";
import { Pill } from "../../components/ui/Pill";
import { ListSkeleton } from "../../components/ui/Skeleton";
import { errorMessage } from "../../lib/errorMessage";
import { useI18n } from "../../lib/i18n";
import { getMyCapabilityReach } from "../../services/capabilities";
import { findNode, getOrgTree } from "../../services/nodes";

// Who currently sits in this unit's seats. Assigning or vacating a seat is
// the organisation chart's own job -- it owns the tree's seat-management UI,
// and its writes are what keeps a seat's history correct -- so this screen
// only reads the holders and hands off to a person's own page.
export function UnitPeoplePage(): JSX.Element {
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
    return <ListSkeleton rows={4} label={t("common.loading")} />;
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

  const seats = [...node.seats].sort((a, b) => a.rank_ordinal - b.rank_ordinal);

  return (
    <div className="space-y-6">
      <div>
        <Link
          to={`/org/node/${nodeId}`}
          className="inline-flex min-h-11 items-center text-sm text-accent-text hover:underline"
        >
          {t("unit.back_to_node")}
        </Link>
        <h1 className="mt-2 font-display text-2xl font-bold text-ink">{t("people.title")}</h1>
      </div>

      <Card>
        {seats.length === 0 ? (
          <Empty title={t("orgtree.no_seats")} />
        ) : (
          <div className="space-y-2">
            {seats.map((seat) => (
              <div
                key={seat.position_id}
                className="flex items-center justify-between gap-2 border-b border-hairline pb-2 last:border-0 last:pb-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-sm text-ink">{seat.title}</div>
                  <div className="text-xs text-ink-muted">{seat.rank_key}</div>
                </div>
                {seat.person_id ? (
                  <Link
                    to={`/org/node/${nodeId}/person/${seat.person_id}`}
                    className="text-sm font-medium text-accent-text hover:underline"
                  >
                    {seat.person_name}
                    {seat.employee_code ? ` · ${seat.employee_code}` : ""}
                  </Link>
                ) : (
                  <Pill>{t("orgtree.seat_vacant")}</Pill>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
