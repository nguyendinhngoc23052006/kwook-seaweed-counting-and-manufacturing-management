import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { type JSX, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { AddFieldWorkerDialog } from "../../components/org/AddFieldWorkerDialog";
import { AssignSeatDialog } from "../../components/org/AssignSeatDialog";
import { CreatePositionDialog } from "../../components/org/CreatePositionDialog";
import { EditPositionDialog } from "../../components/org/EditPositionDialog";
import { MoveNodeDialog } from "../../components/org/MoveNodeDialog";
import { NodeCapabilityPanel } from "../../components/org/NodeCapabilityPanel";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";
import { Empty, ErrorState } from "../../components/ui/EmptyState";
import { Input, Label } from "../../components/ui/Input";
import { ListRow, ListRows } from "../../components/ui/ListRow";
import { Pill } from "../../components/ui/Pill";
import { Section } from "../../components/ui/Section";
import { Select } from "../../components/ui/Select";
import { ListSkeleton } from "../../components/ui/Skeleton";
import { errorMessage } from "../../lib/errorMessage";
import { useI18n } from "../../lib/i18n";
import { personStatusById, seatOccupantStatusTone } from "../../lib/orgLabels";
import { capabilityReaches, getMyCapabilityReach } from "../../services/capabilities";
import {
  breadcrumbOf,
  childrenOf,
  createChildNode,
  findNode,
  getNodeHistory,
  getOrgTree,
  indexChildren,
  isNodeEffectivelyActive,
  listNodeNatures,
  type OrgTreeNode,
  type OrgTreeSeat,
  rootNode,
  setNodeActive,
  setNodeNature,
} from "../../services/nodes";

import { listVisiblePersons } from "../../services/people";
import { listRanks } from "../../services/ranks";

// Nature and rank names are catalogue rows (node_natures, ranks), not an enum
// baked into this file — this repo has no src/types/database.ts, so nodes.ts
// and positions.ts carry the shapes locally and this page reads the labels
// straight off what those queries return.
function natureLabelFor(
  natures: { key: string; name_vi: string; name_en: string }[],
  key: string | null,
  locale: string,
): string | null {
  if (!key) return null;
  const nature = natures.find((n) => n.key === key);
  if (!nature) return null;
  return locale === "en" ? nature.name_en : nature.name_vi;
}

function rankLabelForKey(
  ranks: { key: string; name_vi: string; name_en: string | null }[],
  key: string,
  locale: string,
): string {
  const rank = ranks.find((r) => r.key === key);
  if (!rank) return key;
  return (locale === "en" ? rank.name_en : rank.name_vi) || rank.name_vi;
}

function nodeLabel(node: { name: string; name_en: string | null }, locale: string): string {
  return (locale === "en" ? node.name_en : node.name) || node.name;
}

function seatsByRank(node: OrgTreeNode): OrgTreeSeat[] {
  return [...node.seats].sort(
    (a, b) => a.rank_ordinal - b.rank_ordinal || a.title.localeCompare(b.title, "vi"),
  );
}

function historyStamp(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : format(parsed, "dd/MM/yyyy HH:mm");
}

function asRow(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

type TFn = ReturnType<typeof useI18n>["t"];

// org_node_history (8.11) carries the raw before/after column snapshot, not a
// diff -- a viewer reading raw JSON is exactly the "unprofessional" complaint
// this feature exists to fix, so every row here is turned into one plain
// sentence naming only the columns a human would ask about.
function summarizeNodeChange(
  before: unknown,
  after: unknown,
  natures: { key: string; name_vi: string; name_en: string }[],
  locale: string,
  t: TFn,
): string | null {
  const b = asRow(before);
  const a = asRow(after);
  const parts: string[] = [];

  if (a.name !== b.name || a.name_en !== b.name_en) {
    const label =
      locale === "en"
        ? (a.name_en as string | undefined) || (a.name as string | undefined)
        : (a.name as string | undefined);
    if (label) parts.push(t("node_history.renamed", { name: label }));
  }
  if (a.nature_key !== b.nature_key) {
    const key = (a.nature_key as string | null) ?? null;
    parts.push(
      key
        ? t("node_history.type_set", { nature: natureLabelFor(natures, key, locale) ?? key })
        : t("node_history.type_cleared"),
    );
  }
  if (a.active !== b.active) {
    parts.push(a.active ? t("node_history.reactivated") : t("node_history.deactivated"));
  }
  if (a.parent_id !== b.parent_id) {
    parts.push(t("node_history.moved"));
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

// Same row shape and working links for both the active and the archived
// children list -- an archived unit must stay fully navigable once its
// disclosure is opened, this is hiding by default, not disabling.
function childRow(
  child: OrgTreeNode,
  childIndex: Map<string, OrgTreeNode[]>,
  natures: { key: string; name_vi: string; name_en: string }[],
  locale: string,
  t: TFn,
): JSX.Element {
  const childNatureName = natureLabelFor(natures, child.nature, locale);
  return (
    <ListRow
      key={child.id}
      to={`/org/node/${child.id}`}
      title={nodeLabel(child, locale)}
      subtitle={t("orgtree.child_counts", {
        children: childrenOf(childIndex, child.id).length,
        seats: child.seats.length,
        staffed: child.seats.filter((seat) => seat.person_id).length,
      })}
      meta={
        <span className="flex flex-wrap items-center gap-1">
          {childNatureName && <Pill tone="accent">{childNatureName}</Pill>}
          {!child.active && <Pill tone="danger">{t("orgtree.inactive")}</Pill>}
        </span>
      }
    />
  );
}

// Deactivating a unit (the Deactivate button above) only marked it -- nothing
// ever stopped rendering it, so an archived unit stayed indistinguishable from
// a live one but for a small pill. This gives it real archive semantics:
// collapsed by default, same interaction pattern as
// NodeCapabilityPanel's CapabilityHistoryDisclosure, and still fully
// navigable once opened.
function ArchivedChildrenSection(props: {
  archivedChildren: OrgTreeNode[];
  childIndex: Map<string, OrgTreeNode[]>;
  natures: { key: string; name_vi: string; name_en: string }[];
  locale: string;
  t: TFn;
}): JSX.Element {
  const { archivedChildren, childIndex, natures, locale, t } = props;
  const [open, setOpen] = useState(false);

  return (
    <div className="pt-2">
      <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open
          ? t("orgtree.hide_archived_children")
          : t("orgtree.show_archived_children", { count: archivedChildren.length })}
      </Button>
      {open && (
        <div className="pt-2">
          <ListRows>
            {archivedChildren.map((child) => childRow(child, childIndex, natures, locale, t))}
          </ListRows>
        </div>
      )}
    </div>
  );
}

// Collapsed by default and its query only fires once expanded -- same shape as
// NodeCapabilityPanel's CapabilityHistoryDisclosure, one tier up as its own
// Section rather than a per-row disclosure.
function NodeHistorySection(props: {
  node: OrgTreeNode;
  natures: { key: string; name_vi: string; name_en: string }[];
  locale: string;
  t: TFn;
}): JSX.Element {
  const { node, natures, locale, t } = props;
  const [open, setOpen] = useState(false);

  const history = useQuery({
    queryKey: ["org", "node-history", node.id],
    queryFn: () => getNodeHistory(node.id),
    enabled: open,
  });

  return (
    <Section
      title={t("node_history.title")}
      description={t("node_history.description")}
      action={
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? t("node_history.hide") : t("node_history.show")}
        </Button>
      }
    >
      {!open ? (
        <p className="py-2 text-sm text-ink-muted">{t("node_history.collapsed_hint")}</p>
      ) : history.isLoading ? (
        <ListSkeleton rows={3} label={t("node_history.loading")} />
      ) : history.isError ? (
        <ErrorState
          message={errorMessage(history.error, t("node_history.load_failed"))}
          action={
            <Button size="sm" onClick={() => history.refetch()}>
              {t("common.retry")}
            </Button>
          }
        />
      ) : (history.data ?? []).length === 0 ? (
        <p className="py-2 text-sm text-ink-muted">{t("node_history.empty")}</p>
      ) : (
        <ul className="divide-y divide-hairline">
          {(history.data ?? []).map((entry, index) => {
            const actionKey =
              entry.action === "insert" ? "node_history.created" : "node_history.updated";
            const summary =
              entry.action === "update"
                ? summarizeNodeChange(entry.before_json, entry.after_json, natures, locale, t)
                : null;
            return (
              <li key={`${entry.at}-${index}`} className="py-2 text-sm text-ink">
                <span className="text-ink-muted">{historyStamp(entry.at)}</span> ·{" "}
                <span>{t(actionKey)}</span>
                {summary && <span className="text-ink-muted"> — {summary}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

// The tree browser. One node at a time — its children, its seats and the people
// in them — with a breadcrumb back to the root, because the tree grows deeper
// as well as wider and a back button is not a position.
//
// Kwook's org_nodes table starts with exactly one row (the root, no children,
// no positions, nobody seated), so on a fresh install this renders the root
// with empty Children/Seats sections and the create-first-child action —
// that is the correct state, not a bug.
export function NodePage(): JSX.Element {
  const { nodeId } = useParams<{ nodeId: string }>();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();

  const [showChildForm, setShowChildForm] = useState(false);
  const [childName, setChildName] = useState("");
  const [childNameEn, setChildNameEn] = useState("");
  const [childNature, setChildNature] = useState("");
  const [natureDraft, setNatureDraft] = useState("");
  const [addFieldWorkerOpen, setAddFieldWorkerOpen] = useState(false);
  const [createPositionOpen, setCreatePositionOpen] = useState(false);
  const [assignSeat, setAssignSeat] = useState<OrgTreeSeat | null>(null);
  const [editSeat, setEditSeat] = useState<OrgTreeSeat | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const [confirmReactivate, setConfirmReactivate] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tree = useQuery({ queryKey: ["org", "tree"], queryFn: getOrgTree });
  const reach = useQuery({
    queryKey: ["org", "reach"],
    queryFn: getMyCapabilityReach,
  });
  const natures = useQuery({
    queryKey: ["org", "node-natures"],
    queryFn: listNodeNatures,
  });
  const ranks = useQuery({ queryKey: ["org", "ranks"], queryFn: listRanks });
  // Same cache key NodeCapabilityPanel already reads persons under -- one
  // fetch serves both. Status is the one column org_tree()'s holder join
  // never checks, so a departed/suspended occupant needs it looked up here.
  const persons = useQuery({ queryKey: ["org", "persons"], queryFn: listVisiblePersons });

  // Split by what each mutation actually changed, instead of one shared
  // invalidate() -- chooseNature/setActive touch only this node's own row (so
  // only "tree" and this node's own history), addChild/move can change what a
  // non-strict reach walk sees but never touch persons, and only the
  // seat/person-writing dialogs below need "persons" invalidated at all.
  const invalidateTree = () => queryClient.invalidateQueries({ queryKey: ["org", "tree"] });
  const invalidateReach = () => queryClient.invalidateQueries({ queryKey: ["org", "reach"] });
  const invalidatePersons = () => queryClient.invalidateQueries({ queryKey: ["org", "persons"] });
  const invalidateNodeHistory = (targetId: string) =>
    queryClient.invalidateQueries({ queryKey: ["org", "node-history", targetId] });
  const invalidateAfterSeatWrite = () => {
    invalidateTree();
    invalidateReach();
    invalidatePersons();
  };

  const addChild = useMutation({
    mutationFn: (parentId: string) =>
      createChildNode({
        parentId,
        name: childName,
        nameEn: childNameEn,
        natureKey: childNature || null,
      }),
    onSuccess: () => {
      setChildName("");
      setChildNameEn("");
      setChildNature("");
      setShowChildForm(false);
      setError(null);
      invalidateTree();
      invalidateReach();
    },
    onError: (e) => setError(errorMessage(e, t("orgtree.write_failed"))),
  });

  const chooseNature = useMutation({
    mutationFn: (target: string) => setNodeNature(target, natureDraft || null),
    onSuccess: (_data, target) => {
      setNatureDraft("");
      setError(null);
      invalidateTree();
      invalidateNodeHistory(target);
    },
    onError: (e) => setError(errorMessage(e, t("orgtree.write_failed"))),
  });

  const setActive = useMutation({
    mutationFn: (input: { id: string; active: boolean }) => setNodeActive(input.id, input.active),
    onSuccess: (_data, variables) => {
      setConfirmDeactivate(false);
      setConfirmReactivate(false);
      setError(null);
      invalidateTree();
      invalidateNodeHistory(variables.id);
    },
    onError: (e) => setError(errorMessage(e, t("orgtree.write_failed"))),
  });

  if (tree.isLoading || reach.isLoading) {
    return <ListSkeleton rows={6} label={t("orgtree.loading")} />;
  }

  if (tree.isError || reach.isError) {
    return (
      <ErrorState
        message={errorMessage(tree.error ?? reach.error, t("orgtree.load_failed"))}
        action={
          <Button
            onClick={() => {
              tree.refetch();
              reach.refetch();
            }}
          >
            {t("common.retry")}
          </Button>
        }
      />
    );
  }

  const nodes = tree.data ?? [];
  const myReach = reach.data;

  // org_tree() returns [] to a caller the model does not know yet — a fresh
  // account with no seat. That is a sentence, not an error and not a spinner.
  if (nodes.length === 0) {
    return (
      <Empty
        title={t("orgtree.empty")}
        description={myReach?.isAdmin ? t("orgtree.empty_admin") : t("orgtree.empty_hint")}
      />
    );
  }

  const node = nodeId ? findNode(nodes, nodeId) : rootNode(nodes);
  if (!node) {
    return (
      <ErrorState
        message={t("orgtree.node_not_found")}
        action={
          <Link to="/org/node" className="text-sm text-primary-text underline">
            {t("orgtree.back_to_root")}
          </Link>
        }
      />
    );
  }

  const trail = breadcrumbOf(nodes, node.id);
  const childIndex = indexChildren(nodes);
  const children = childrenOf(childIndex, node.id);
  const activeChildren = children.filter((child) => child.active !== false);
  const archivedChildren = children.filter((child) => child.active === false);
  const seats = seatsByRank(node);
  const personStatuses = personStatusById(persons.data ?? []);
  const staffed = seats.filter((seat) => seat.person_id).length;

  // Frozen if this node OR any ancestor is inactive (org_node_effectively_active,
  // 20260924000000_freeze_inactive_subtrees.sql) -- node.active alone misses an
  // active node sitting under an inactive ancestor, since deactivating a node
  // never cascades the column to its children.
  const effectivelyActive = isNodeEffectivelyActive(nodes, node.id);

  // What the viewer may actually do here. A control nobody may use is not
  // drawn at all — a disabled button reads as a broken app, a sentence reads
  // as an explanation.
  const canAddChild = capabilityReaches(myReach, "create_child_node", node.id);
  const canAppoint = capabilityReaches(myReach, "appoint_into_seat_below", node.id);
  const canConfigure = capabilityReaches(myReach, "configure_child_capabilities", node.id);
  const canSeeCameras =
    capabilityReaches(myReach, "manage_camera_devices", node.id) ||
    capabilityReaches(myReach, "view_camera_data", node.id);
  // capabilityReaches() is true for an admin everywhere, whether or not this
  // node itself was ever granted the capability -- correct (an admin really
  // can reach every node), but showing the link with no distinction reads as
  // "this node has camera access" when the ledger right below it may say
  // "Chưa cấp". node.capabilities carries only this node's own EXPLICIT
  // grants (no inheritance), so it's the one signal that tells the two cases
  // apart without another query.
  const hasExplicitCameraGrant =
    node.capabilities.includes("manage_camera_devices") ||
    node.capabilities.includes("view_camera_data");
  const canMaintainProfile = capabilityReaches(myReach, "maintain_person_profile", node.id);
  const canMaintainBank = capabilityReaches(myReach, "maintain_bank_details", node.id);

  const natureName = natureLabelFor(natures.data ?? [], node.nature, locale);
  const isField = node.nature === "field";

  return (
    <div className="space-y-6">
      <nav aria-label={t("orgtree.breadcrumb")} className="overflow-x-auto">
        <ol className="flex items-center gap-1 whitespace-nowrap text-sm">
          {trail.map((step, index) => (
            <li key={step.id} className="flex items-center gap-1">
              {index > 0 && <span className="text-ink-faint">/</span>}
              {step.id === node.id ? (
                <span aria-current="page" className="px-1 py-2 font-medium text-ink">
                  {nodeLabel(step, locale)}
                </span>
              ) : (
                <Link
                  to={`/org/node/${step.id}`}
                  className="inline-flex min-h-11 items-center px-1 text-primary-text hover:underline"
                >
                  {nodeLabel(step, locale)}
                </Link>
              )}
            </li>
          ))}
        </ol>
      </nav>

      <div className="flex flex-wrap items-center gap-2">
        <h1 className="font-display text-2xl font-bold text-ink">{nodeLabel(node, locale)}</h1>
        {natureName && (
          <Pill tone="accent">
            {node.nature_set_here
              ? natureName
              : t("orgtree.nature_inherited", { nature: natureName })}
          </Pill>
        )}
        {!node.active && <Pill tone="danger">{t("orgtree.inactive")}</Pill>}
        <Pill>{t("orgtree.counts", { seats: seats.length, staffed })}</Pill>
        <Link
          to={`/org/work?node=${node.id}`}
          className="inline-flex min-h-11 items-center rounded-lg border border-hairline px-3 text-sm font-medium text-primary-text hover:bg-surface-muted"
        >
          {t("nav.work")}
        </Link>

        {myReach?.isAdmin === true && (
          <Button size="sm" variant="secondary" onClick={() => setMoveOpen(true)}>
            {t("orgtree.move")}
          </Button>
        )}

        {/* The root unit is the company itself and can never be archived
            (org_guard_nodes refuses it), so it gets no lifecycle button. */}
        {canAddChild &&
          node.parent_id !== null &&
          (node.active ? (
            confirmDeactivate ? (
              <>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={setActive.isPending}
                  onClick={() => setActive.mutate({ id: node.id, active: false })}
                >
                  {setActive.isPending ? t("common.loading") : t("orgtree.deactivate_confirm")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={setActive.isPending}
                  onClick={() => setConfirmDeactivate(false)}
                >
                  {t("common.cancel")}
                </Button>
              </>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => setConfirmDeactivate(true)}>
                {t("orgtree.deactivate")}
              </Button>
            )
          ) : confirmReactivate ? (
            <>
              <Button
                size="sm"
                variant="danger"
                disabled={setActive.isPending}
                onClick={() => setActive.mutate({ id: node.id, active: true })}
              >
                {setActive.isPending ? t("common.loading") : t("orgtree.reactivate_confirm")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={setActive.isPending}
                onClick={() => setConfirmReactivate(false)}
              >
                {t("common.cancel")}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => setConfirmReactivate(true)}>
              {t("orgtree.reactivate")}
            </Button>
          ))}
      </div>

      {/* The one place this signal ever surfaces to someone who reached this
          node directly (bookmark, move destination, shared link) -- the chart's
          hide-by-default only protects its own default view. */}
      {node.active && !effectivelyActive && (
        <Alert variant="warning">{t("orgtree.archived_branch_banner")}</Alert>
      )}

      {error && <Alert variant="error">{error}</Alert>}

      {/* Natures and ranks are catalogues, not the tree: losing one degrades a
          picker rather than the page, so it is said plainly and the rest of the
          screen keeps working. */}
      {natures.isError && <Alert variant="warning">{t("orgtree.natures_failed")}</Alert>}

      {/* Nature decides which doorway opens, and a migration cannot guess it.
          Until someone sets it, the screen asks rather than choosing one. */}
      {node.nature === null && (
        <Alert variant="info">
          <p>{t("orgtree.nature_missing")}</p>
          {canAddChild && (
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <div className="min-w-56 flex-1">
                <Label htmlFor="node-nature">{t("orgtree.nature")}</Label>
                <Select
                  id="node-nature"
                  value={natureDraft}
                  onChange={(value) => setNatureDraft(value)}
                  ariaLabel={t("orgtree.nature")}
                  options={[
                    { value: "", label: t("orgtree.pick_nature") },
                    ...(natures.data ?? []).map((nature) => ({
                      value: nature.key,
                      label: locale === "en" ? nature.name_en : nature.name_vi,
                    })),
                  ]}
                />
              </div>
              <Button
                disabled={!natureDraft || chooseNature.isPending}
                onClick={() => chooseNature.mutate(node.id)}
              >
                {t("common.save")}
              </Button>
            </div>
          )}
        </Alert>
      )}

      <Section
        title={t("orgtree.children")}
        description={t("orgtree.children_hint")}
        action={
          canAddChild ? (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={!effectivelyActive}
                onClick={() => setShowChildForm(!showChildForm)}
              >
                {t("orgtree.add_child")}
              </Button>
              {!effectivelyActive && (
                <span className="text-xs text-ink-muted">
                  {t("orgtree.archived_write_blocked")}
                </span>
              )}
            </div>
          ) : undefined
        }
      >
        {canAddChild && showChildForm && (
          <form
            className="space-y-3 py-3"
            onSubmit={(e) => {
              e.preventDefault();
              addChild.mutate(node.id);
            }}
          >
            <div>
              <Label htmlFor="child-name">{t("orgtree.child_name")}</Label>
              <Input
                id="child-name"
                value={childName}
                onChange={(e) => setChildName(e.target.value)}
                placeholder={t("orgtree.child_name_placeholder")}
                disabled={addChild.isPending}
              />
            </div>
            <div>
              <Label htmlFor="child-name-en">{t("orgtree.child_name_en")}</Label>
              <Input
                id="child-name-en"
                value={childNameEn}
                onChange={(e) => setChildNameEn(e.target.value)}
                disabled={addChild.isPending}
              />
            </div>
            <div>
              <Label htmlFor="child-nature">{t("orgtree.child_nature")}</Label>
              <Select
                id="child-nature"
                value={childNature}
                onChange={(value) => setChildNature(value)}
                disabled={addChild.isPending}
                ariaLabel={t("orgtree.child_nature")}
                options={[
                  { value: "", label: t("orgtree.nature_inherit") },
                  ...(natures.data ?? []).map((nature) => ({
                    value: nature.key,
                    label: locale === "en" ? nature.name_en : nature.name_vi,
                  })),
                ]}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="submit"
                disabled={!childName.trim() || addChild.isPending || !effectivelyActive}
              >
                {addChild.isPending ? t("common.loading") : t("orgtree.create_child")}
              </Button>
              <Button
                variant="ghost"
                onClick={() => setShowChildForm(false)}
                disabled={addChild.isPending}
              >
                {t("common.cancel")}
              </Button>
              {!effectivelyActive && (
                <span className="text-xs text-ink-muted">
                  {t("orgtree.archived_write_blocked")}
                </span>
              )}
            </div>
          </form>
        )}

        {activeChildren.length === 0 ? (
          <Empty
            title={t("orgtree.no_children")}
            description={
              canAddChild ? t("orgtree.no_children_admin") : t("orgtree.no_children_hint")
            }
          />
        ) : (
          <ListRows>
            {activeChildren.map((child) =>
              childRow(child, childIndex, natures.data ?? [], locale, t),
            )}
          </ListRows>
        )}
        {archivedChildren.length > 0 && (
          <ArchivedChildrenSection
            archivedChildren={archivedChildren}
            childIndex={childIndex}
            natures={natures.data ?? []}
            locale={locale}
            t={t}
          />
        )}
      </Section>

      <Section
        title={t("orgtree.seats")}
        description={t("orgtree.seats_hint")}
        action={
          canAppoint && node.nature !== null ? (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                size="sm"
                disabled={!effectivelyActive}
                onClick={() =>
                  isField ? setAddFieldWorkerOpen(true) : setCreatePositionOpen(true)
                }
              >
                {isField ? t("orgtree.add_person") : t("orgtree.add_position")}
              </Button>
              {!effectivelyActive && (
                <span className="text-xs text-ink-muted">
                  {t("orgtree.archived_write_blocked")}
                </span>
              )}
            </div>
          ) : undefined
        }
      >
        {ranks.isError && (
          <div className="py-2">
            <Alert variant="warning">{t("orgtree.ranks_failed")}</Alert>
          </div>
        )}
        {seats.length === 0 ? (
          <Empty
            title={t("orgtree.no_seats")}
            description={
              node.nature === null
                ? t("orgtree.no_seats_nature")
                : canAppoint
                  ? isField
                    ? t("orgtree.no_seats_field")
                    : t("orgtree.no_seats_office")
                  : t("orgtree.no_seats_hint")
            }
          />
        ) : (
          <ListRows>
            {seats.map((seat) => {
              const occupantStatus = seat.person_id
                ? personStatuses.get(seat.person_id)
                : undefined;
              const occupantTone = seatOccupantStatusTone(occupantStatus);
              return (
                <ListRow
                  key={seat.position_id}
                  to={seat.person_id ? `/org/node/${node.id}/person/${seat.person_id}` : undefined}
                  title={seat.title}
                  subtitle={
                    seat.person_id
                      ? t("orgtree.seat_held", {
                          name: seat.person_name ?? "",
                          code: seat.employee_code ?? "",
                        })
                      : t("orgtree.seat_vacant")
                  }
                  meta={
                    <span className="flex flex-wrap items-center gap-1">
                      <Pill tone={seat.person_id ? "neutral" : "warning"}>
                        {rankLabelForKey(ranks.data ?? [], seat.rank_key, locale)}
                      </Pill>
                      {occupantTone && (
                        <Pill tone={occupantTone}>{t(`person_status.${occupantStatus}`)}</Pill>
                      )}
                    </span>
                  }
                  trailing={
                    canAppoint ? (
                      seat.person_id ? (
                        // Reassigning here would still hit org_seat_person's
                        // appoint guard on an archived branch, but this button
                        // is also the only path to vacating an occupied seat
                        // (frozen writes never block vacate) -- it stays
                        // enabled unconditionally so vacate always stays
                        // reachable.
                        <span className="flex flex-wrap items-center justify-end gap-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setEditSeat(seat)}
                            disabled={!effectivelyActive}
                          >
                            {t("seat_edit.open")}
                          </Button>
                          <Button size="sm" variant="secondary" onClick={() => setAssignSeat(seat)}>
                            {t("orgtree.manage_seat")}
                          </Button>
                        </span>
                      ) : (
                        <span className="flex flex-wrap items-center justify-end gap-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!effectivelyActive}
                            onClick={() => setEditSeat(seat)}
                          >
                            {t("seat_edit.open")}
                          </Button>
                          <Button
                            size="sm"
                            variant="primary"
                            disabled={!effectivelyActive}
                            onClick={() => setAssignSeat(seat)}
                          >
                            {t("orgtree.assign")}
                          </Button>
                          {!effectivelyActive && (
                            <span className="text-xs text-ink-muted">
                              {t("orgtree.archived_write_blocked")}
                            </span>
                          )}
                        </span>
                      )
                    ) : undefined
                  }
                />
              );
            })}
          </ListRows>
        )}
      </Section>

      {canSeeCameras && (
        <Section
          title={t("device.admin_title")}
          action={
            !hasExplicitCameraGrant ? (
              <Pill tone="accent">{t("device.admin_access_only")}</Pill>
            ) : undefined
          }
        >
          <ListRows>
            <ListRow to={`/org/node/${node.id}/cameras`} title={t("device.admin_title")} />
          </ListRows>
        </Section>
      )}

      <NodeCapabilityPanel
        nodeId={node.id}
        nodeName={nodeLabel(node, locale)}
        canConfigure={canConfigure}
        effectivelyActive={effectivelyActive}
      />

      {canAddChild && (
        <NodeHistorySection node={node} natures={natures.data ?? []} locale={locale} t={t} />
      )}

      {moveOpen && (
        <MoveNodeDialog
          open={true}
          onClose={() => setMoveOpen(false)}
          onMoved={() => {
            invalidateTree();
            invalidateReach();
            invalidateNodeHistory(node.id);
          }}
          node={node}
          nodes={nodes}
        />
      )}

      {addFieldWorkerOpen && (
        <AddFieldWorkerDialog
          open={addFieldWorkerOpen}
          onClose={() => setAddFieldWorkerOpen(false)}
          onCreated={invalidateAfterSeatWrite}
          node={node}
          nodes={nodes}
          ranks={ranks.data ?? []}
          canMaintainProfile={canMaintainProfile}
          canMaintainBank={canMaintainBank}
          isAdmin={myReach?.isAdmin === true}
        />
      )}

      {createPositionOpen && (
        <CreatePositionDialog
          open={createPositionOpen}
          onClose={() => setCreatePositionOpen(false)}
          onCreated={invalidateAfterSeatWrite}
          node={node}
          nodes={nodes}
          ranks={ranks.data ?? []}
          isAdmin={myReach?.isAdmin === true}
          canMaintainProfile={canMaintainProfile}
          canMaintainBank={canMaintainBank}
        />
      )}

      {editSeat && (
        <EditPositionDialog
          open={true}
          onClose={() => setEditSeat(null)}
          onSaved={invalidateAfterSeatWrite}
          seat={editSeat}
          nodes={nodes}
          nodeId={node.id}
          ranks={ranks.data ?? []}
          myRankOrdinal={myReach?.isAdmin ? null : (myReach?.rankOrdinal ?? null)}
        />
      )}

      {assignSeat && (
        <AssignSeatDialog
          open={true}
          onClose={() => setAssignSeat(null)}
          onDone={invalidateAfterSeatWrite}
          seat={assignSeat}
          node={node}
          canMaintainProfile={canMaintainProfile}
          canMaintainBank={canMaintainBank}
          myPersonId={myReach?.personId ?? null}
        />
      )}
    </div>
  );
}
