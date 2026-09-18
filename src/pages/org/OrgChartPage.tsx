import { useQuery } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { Link } from "react-router-dom";
import { Empty, ErrorState } from "../../components/ui/EmptyState";
import { Pill } from "../../components/ui/Pill";
import { ListSkeleton } from "../../components/ui/Skeleton";
import { errorMessage } from "../../lib/errorMessage";
import { useI18n } from "../../lib/i18n";
import {
  childrenOf,
  getOrgTree,
  indexChildren,
  listNodeNatures,
  type NodeNature,
  type OrgTreeNode,
} from "../../services/nodes";

// Same depth cap the SQL walks and breadcrumbOf() use: the triggers refuse a
// cycle unconditionally, so this is pure insurance against a hypothetical
// direct-SQL data corruption bypassing that guard -- not a real org-size limit.
const MAX_DEPTH = 100000;

// How deep the chart opens on arrival. The layout is a nested flex tree, so a
// subtree's width is the sum of its leaves'. Kwook has one location today, so
// this mostly opens the whole thing; the cap matters once the tree grows.
const OPEN_TO_DEPTH = 2;

// Names the CEO types at runtime live in the data, in both languages; no
// reviewer sees them, so there is no i18n key to fall back on. English falls
// back to Vietnamese rather than rendering an empty label.
function nodeLabel(node: OrgTreeNode, locale: string): string {
  return locale === "en" ? (node.name_en ?? node.name) : node.name;
}

function natureLabelFor(natures: NodeNature[], key: string | null, locale: string): string | null {
  if (!key) return null;
  const match = natures.find((nature) => nature.key === key);
  if (!match) return key;
  return locale === "en" ? match.name_en : match.name_vi;
}

function seatLines(node: OrgTreeNode): OrgTreeNode["seats"] {
  return [...node.seats].sort((a, b) => a.rank_ordinal - b.rank_ordinal).slice(0, 3);
}

function NodeBox({
  node,
  natures,
  locale,
  t,
}: {
  node: OrgTreeNode;
  natures: NodeNature[];
  locale: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const nature = natureLabelFor(natures, node.nature, locale);
  const shown = seatLines(node);
  const staffed = node.seats.filter((seat) => seat.person_id).length;

  return (
    <Link
      to={`/org/node/${node.id}`}
      className="inline-block min-w-44 max-w-64 rounded-lg border border-hairline bg-surface-raised px-3 py-2 text-left shadow-sm transition hover:border-accent hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <div className="text-sm font-bold text-ink">{nodeLabel(node, locale)}</div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {nature && <Pill tone="accent">{nature}</Pill>}
        {!node.active && <Pill tone="danger">{t("orgtree.inactive")}</Pill>}
        <Pill>{t("orgtree.counts", { seats: node.seats.length, staffed })}</Pill>
      </div>
      {shown.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {shown.map((seat) => (
            <li key={seat.position_id} className="text-xs leading-snug">
              <span className="text-ink-muted">{seat.title}</span>{" "}
              <span className={seat.person_name ? "font-medium text-ink" : "text-ink-faint"}>
                {seat.person_name ?? t("orgtree.seat_vacant")}
              </span>
            </li>
          ))}
          {node.seats.length > shown.length && (
            <li className="text-xs text-ink-faint">
              {t("orgchart.more_seats", {
                count: node.seats.length - shown.length,
              })}
            </li>
          )}
        </ul>
      )}
    </Link>
  );
}

function Branch({
  node,
  index,
  natures,
  locale,
  t,
  depth,
  opened,
  onToggle,
}: {
  node: OrgTreeNode;
  index: Map<string, OrgTreeNode[]>;
  natures: NodeNature[];
  locale: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
  depth: number;
  opened: Set<string>;
  onToggle: (id: string) => void;
}): JSX.Element {
  const children = depth < MAX_DEPTH ? childrenOf(index, node.id) : [];
  const show = depth < OPEN_TO_DEPTH || opened.has(node.id);
  const buried = countBelow(index, node.id);
  return (
    <li>
      <NodeBox node={node} natures={natures} locale={locale} t={t} />
      {children.length > 0 && (
        <button
          type="button"
          onClick={() => onToggle(node.id)}
          aria-expanded={show}
          className="mt-1 inline-flex min-h-8 items-center rounded-full border border-hairline bg-surface-raised px-3 text-xs font-medium text-accent-text transition hover:border-accent"
        >
          {show ? t("orgchart.collapse") : t("orgchart.expand", { count: buried })}
        </button>
      )}
      {children.length > 0 && show && (
        <ul>
          {children.map((child) => (
            <Branch
              key={child.id}
              node={child}
              index={index}
              natures={natures}
              locale={locale}
              t={t}
              depth={depth + 1}
              opened={opened}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// How many boxes are hidden under this one, so the button can say what opening
// it costs rather than making you find out.
function countBelow(index: Map<string, OrgTreeNode[]>, id: string): number {
  let n = 0;
  const stack = [...(index.get(id) ?? [])];
  while (stack.length > 0 && n < 9999) {
    const next = stack.pop();
    if (!next) break;
    n += 1;
    stack.push(...(index.get(next.id) ?? []));
  }
  return n;
}

// The whole organisation as one picture, drawn from the same org_tree()
// snapshot the node browser reads. Every box is a link into that box, so the
// chart is a way to work with the tree rather than a poster of it.
export function OrgChartPage(): JSX.Element {
  const { t, locale } = useI18n();
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) =>
    setOpened((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const tree = useQuery({ queryKey: ["org", "tree"], queryFn: getOrgTree });
  const natures = useQuery({
    queryKey: ["org", "node-natures"],
    queryFn: listNodeNatures,
  });

  if (tree.isLoading) return <ListSkeleton rows={4} label={t("orgtree.loading")} />;
  if (tree.isError) {
    return <ErrorState message={errorMessage(tree.error, t("orgtree.load_failed"))} />;
  }

  const nodes = tree.data ?? [];
  const index = indexChildren(nodes);
  const roots = nodes.filter((n) => n.parent_id === null);
  if (roots.length === 0) {
    return <Empty title={t("orgtree.empty")} description={t("orgtree.empty_hint")} />;
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-2xl font-bold text-ink">{t("orgchart.title")}</h1>
        <p className="text-sm text-ink-muted">{t("orgchart.hint")}</p>
      </div>
      <div className="overflow-x-auto pb-4">
        <div className="org-tree min-w-max">
          <ul>
            {roots.map((root) => (
              <Branch
                key={root.id}
                node={root}
                index={index}
                natures={natures.data ?? []}
                locale={locale}
                t={t}
                depth={1}
                opened={opened}
                onToggle={toggle}
              />
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
