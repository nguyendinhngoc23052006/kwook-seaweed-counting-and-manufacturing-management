import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { type JSX, useState } from "react";
import { errorMessage } from "../../lib/errorMessage";
import { useT } from "../../lib/i18n";
import {
  type CapabilityHistoryEntry,
  type CapabilityKey,
  currentGrants,
  grantCapability,
  grantCapabilityToSubtree,
  isChangingEffect,
  listCapabilityHistory,
  listCapabilityTypes,
  listNodeGrants,
  type NodeCapability,
  previewCapabilityChange,
  previewEffectKey,
  revokeCapability,
  revokeCapabilityInSubtree,
} from "../../services/capabilities";
import { listVisiblePersons } from "../../services/people";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Empty, ErrorState } from "../ui/EmptyState";
import { Input, Label } from "../ui/Input";
import { ListRow, ListRows } from "../ui/ListRow";
import { Pill } from "../ui/Pill";
import { Section } from "../ui/Section";
import { Select } from "../ui/Select";
import { ListSkeleton } from "../ui/Skeleton";

interface Props {
  nodeId: string;
  nodeName: string;
  canConfigure: boolean;
  // Computed the same way as NodePage's own gate (isNodeEffectivelyActive):
  // false blocks only NEW grants (org_guard_node_capabilities freezes
  // granted=true on an inactive branch) -- revoke must keep working
  // unconditionally, so it is never checked below.
  effectivelyActive: boolean;
}

interface PendingChange {
  capabilityKey: CapabilityKey;
  granted: boolean;
  subtree: boolean;
}

function stamp(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : format(parsed, "dd/MM/yyyy HH:mm");
}

type TFn = ReturnType<typeof useT>;

// The disclosure owns its own open/closed state and its own history query --
// listNodeGrants already returns this node's whole ledger, but the task this
// panel exists for asks specifically for org_capability_history(): a definer
// RPC that reshapes node_capabilities into the same safe envelope org_audit's
// entries use, without widening a SELECT policy on the table itself. Each row
// in the catalogue below is its own component (not a loop-local closure)
// precisely so this query only runs, and only exists, once its row is opened.
function CapabilityHistoryDisclosure(props: {
  nodeId: string;
  capabilityKey: CapabilityKey;
  count: number;
  personNameById: Map<string, string>;
  t: TFn;
}): JSX.Element {
  const { nodeId, capabilityKey, count, personNameById, t } = props;
  const [open, setOpen] = useState(false);

  const history = useQuery({
    queryKey: ["org", "capability-history", nodeId, capabilityKey],
    queryFn: () => listCapabilityHistory(nodeId, capabilityKey),
    enabled: open,
  });

  const actorName = (entry: CapabilityHistoryEntry): string => {
    if (!entry.actor_person_id) return t("caps.actor_system");
    return personNameById.get(entry.actor_person_id) ?? t("caps.actor_unknown");
  };

  return (
    <div className="pb-2">
      <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? t("caps.hide_history") : t("caps.show_history", { count })}
      </Button>
      {open &&
        (history.isLoading ? (
          <ListSkeleton rows={2} label={t("caps.loading")} />
        ) : history.isError ? (
          <ErrorState
            message={errorMessage(history.error, t("caps.history_load_failed"))}
            action={
              <Button size="sm" onClick={() => history.refetch()}>
                {t("common.retry")}
              </Button>
            }
          />
        ) : (history.data ?? []).length === 0 ? (
          <p className="px-1 text-sm text-ink-muted">{t("caps.no_history")}</p>
        ) : (
          <ul className="mt-1 space-y-1 px-1">
            {(history.data ?? []).map((entry, index) => (
              <li key={`${entry.at}-${index}`} className="text-sm text-ink-muted">
                <span
                  className={entry.action === "grant" ? "text-success-text" : "text-danger-text"}
                >
                  {entry.action === "grant" ? t("caps.granted") : t("caps.revoked")}
                </span>{" "}
                · {stamp(entry.at)} · {actorName(entry)}
                {entry.after_json?.reason ? ` · ${entry.after_json.reason}` : ""}
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

// Capabilities are granted to NODES, never to people, and every grant and every
// revoke is one appended row carrying who wrote it and when. This panel is that
// ledger: the closed vocabulary down the left, this node's own grants beside it
// — no inheritance, so these rows are the whole account — and the history
// behind each one.
export function NodeCapabilityPanel(props: Props): JSX.Element {
  const { nodeId, nodeName, canConfigure, effectivelyActive } = props;
  const t = useT();
  const queryClient = useQueryClient();

  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [written, setWritten] = useState<number | null>(null);
  const [subtreeKey, setSubtreeKey] = useState("");
  const [subtreeAction, setSubtreeAction] = useState("grant");
  const [preview, setPreview] = useState<PendingChange | null>(null);

  const types = useQuery({
    queryKey: ["org", "capability-types"],
    queryFn: listCapabilityTypes,
  });
  const grants = useQuery({
    queryKey: ["org", "node-grants", nodeId],
    queryFn: () => listNodeGrants(nodeId),
  });
  // A grant stores the actor's auth account id; the name beside it comes from
  // the person holding that account, and is simply absent when the reader
  // cannot see them.
  const persons = useQuery({
    queryKey: ["org", "persons"],
    queryFn: listVisiblePersons,
  });

  const previewQuery = useQuery({
    queryKey: ["org", "capability-preview", nodeId, preview],
    queryFn: () =>
      preview
        ? previewCapabilityChange({
            nodeId,
            capabilityKey: preview.capabilityKey,
            granted: preview.granted,
            subtree: true,
          })
        : Promise.resolve([]),
    enabled: preview !== null,
  });

  const change = useMutation({
    mutationFn: (input: PendingChange) => {
      const args = { nodeId, capabilityKey: input.capabilityKey, reason };
      if (input.subtree) {
        return input.granted ? grantCapabilityToSubtree(args) : revokeCapabilityInSubtree(args);
      }
      return input.granted ? grantCapability(args) : revokeCapability(args);
    },
    onSuccess: (rows, input) => {
      setError(null);
      setWritten(rows);
      setReason("");
      setPreview(null);
      if (input.subtree) {
        // A subtree change writes one row per descendant the preview
        // enumerated (org_set_capability, services/capabilities.ts:139-141),
        // not just this node -- invalidate the bare key prefixes (no nodeId
        // suffix) so every open grants/history panel anywhere refetches,
        // rather than only this node's own two queries.
        queryClient.invalidateQueries({ queryKey: ["org", "node-grants"] });
        queryClient.invalidateQueries({ queryKey: ["org", "capability-history"] });
      } else {
        queryClient.invalidateQueries({ queryKey: ["org", "node-grants", nodeId] });
        queryClient.invalidateQueries({ queryKey: ["org", "capability-history", nodeId] });
      }
      queryClient.invalidateQueries({ queryKey: ["org", "tree"] });
      queryClient.invalidateQueries({ queryKey: ["org", "reach"] });
    },
    onError: (e) => setError(errorMessage(e, t("caps.write_failed"))),
  });

  const actorName = (grant: NodeCapability): string => {
    if (!grant.created_by) return t("caps.actor_system");
    const person = (persons.data ?? []).find(
      (candidate) => candidate.account_id === grant.created_by,
    );
    return person ? person.full_name : t("caps.actor_unknown");
  };

  // The history disclosure looks actors up by person id (org_capability_history
  // already resolves created_by -> persons.id server-side), never by account id
  // -- so it needs its own map, keyed differently from actorName() above.
  const personNameById = new Map(
    (persons.data ?? []).map((person) => [person.id, person.full_name]),
  );

  const catalogue = () => {
    if (types.isLoading || grants.isLoading) {
      return <ListSkeleton rows={4} label={t("caps.loading")} />;
    }
    if (types.isError || grants.isError) {
      return (
        <ErrorState
          message={errorMessage(types.error ?? grants.error, t("caps.load_failed"))}
          action={
            <Button
              size="sm"
              onClick={() => {
                types.refetch();
                grants.refetch();
              }}
            >
              {t("common.retry")}
            </Button>
          }
        />
      );
    }

    const vocabulary = types.data ?? [];
    if (vocabulary.length === 0) {
      return <Empty title={t("caps.no_catalogue")} description={t("caps.no_catalogue_hint")} />;
    }

    const rows = grants.data ?? [];
    const head = currentGrants(rows);

    return (
      <ListRows>
        {vocabulary.map((type) => {
          const grant = head.get(type.key);
          const isGranted = grant?.granted === true;
          const historyCount = rows.filter((row) => row.capability_key === type.key).length;
          return (
            <div key={type.key}>
              <ListRow
                title={t(`capability.${type.key}`)}
                subtitle={
                  grant
                    ? t("caps.since", {
                        at: stamp(grant.effective_from),
                        actor: actorName(grant),
                      })
                    : t("caps.never_set")
                }
                meta={
                  <Pill tone={isGranted ? "success" : "neutral"}>
                    {isGranted ? t("caps.granted") : t("caps.not_granted")}
                  </Pill>
                }
                trailing={
                  canConfigure ? (
                    <span className="flex flex-wrap items-center justify-end gap-2">
                      <Button
                        size="sm"
                        variant={isGranted ? "secondary" : "primary"}
                        // Only a NEW grant is frozen on an archived branch
                        // (org_guard_node_capabilities) -- revoke (isGranted
                        // true, about to flip to false) must stay enabled
                        // unconditionally.
                        disabled={change.isPending || (!isGranted && !effectivelyActive)}
                        onClick={() =>
                          change.mutate({
                            capabilityKey: type.key,
                            granted: !isGranted,
                            subtree: false,
                          })
                        }
                      >
                        {isGranted ? t("caps.revoke") : t("caps.grant")}
                      </Button>
                      {!isGranted && !effectivelyActive && (
                        <span className="text-xs text-ink-muted">
                          {t("orgtree.archived_write_blocked")}
                        </span>
                      )}
                    </span>
                  ) : undefined
                }
              />
              <CapabilityHistoryDisclosure
                nodeId={nodeId}
                capabilityKey={type.key}
                count={historyCount}
                personNameById={personNameById}
                t={t}
              />
            </div>
          );
        })}
      </ListRows>
    );
  };

  const selectedType = (types.data ?? []).find((type) => type.key === subtreeKey);
  const previewRows = previewQuery.data ?? [];
  const changing = previewRows.filter((row) => isChangingEffect(row.effect));

  return (
    <Section title={t("caps.title")} description={t("caps.description", { node: nodeName })}>
      {error && (
        <div className="py-2">
          <Alert variant="error">{error}</Alert>
        </div>
      )}
      {written !== null && (
        <div className="py-2">
          <Alert variant="success">{t("caps.written", { count: written })}</Alert>
        </div>
      )}

      {canConfigure && (
        <div className="py-3">
          <Label htmlFor="caps-reason">{t("caps.reason")}</Label>
          <Input
            id="caps-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t("caps.reason_placeholder")}
            disabled={change.isPending}
          />
        </div>
      )}

      {catalogue()}

      {canConfigure ? (
        <div className="space-y-3 border-t border-hairline py-4">
          <div>
            <h3 className="font-display text-base font-semibold text-ink">
              {t("caps.subtree_title")}
            </h3>
            <p className="mt-0.5 text-sm text-ink-muted">{t("caps.subtree_hint")}</p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="caps-subtree-key">{t("caps.subtree_capability")}</Label>
              <Select
                id="caps-subtree-key"
                value={subtreeKey}
                onChange={(value) => {
                  setSubtreeKey(value);
                  setPreview(null);
                }}
                ariaLabel={t("caps.subtree_capability")}
                options={[
                  { value: "", label: t("caps.pick_capability") },
                  ...(types.data ?? []).map((type) => ({
                    value: type.key as string,
                    label: t(`capability.${type.key}`),
                  })),
                ]}
              />
            </div>
            <div>
              <Label htmlFor="caps-subtree-action">{t("caps.subtree_action")}</Label>
              <Select
                id="caps-subtree-action"
                value={subtreeAction}
                onChange={(value) => {
                  setSubtreeAction(value);
                  setPreview(null);
                }}
                ariaLabel={t("caps.subtree_action")}
                options={[
                  { value: "grant", label: t("caps.grant") },
                  { value: "revoke", label: t("caps.revoke") },
                ]}
              />
            </div>
          </div>

          <Button
            variant="secondary"
            disabled={!selectedType}
            onClick={() =>
              selectedType &&
              setPreview({
                capabilityKey: selectedType.key,
                granted: subtreeAction === "grant",
                subtree: true,
              })
            }
          >
            {t("caps.preview")}
          </Button>

          {preview !== null &&
            (previewQuery.isLoading ? (
              <ListSkeleton rows={3} label={t("caps.preview_loading")} />
            ) : previewQuery.isError ? (
              <ErrorState
                message={errorMessage(previewQuery.error, t("caps.preview_failed"))}
                action={
                  <Button size="sm" onClick={() => previewQuery.refetch()}>
                    {t("common.retry")}
                  </Button>
                }
              />
            ) : previewRows.length === 0 ? (
              <Empty title={t("caps.preview_empty")} description={t("caps.preview_empty_hint")} />
            ) : (
              <div className="space-y-3">
                <ul className="divide-y divide-hairline">
                  {previewRows.map((row) => {
                    const key = previewEffectKey(row.effect);
                    return (
                      <li
                        key={row.node_id}
                        className="flex min-h-11 flex-wrap items-center justify-between gap-2 py-2"
                      >
                        <span className="text-sm text-ink">{row.node_name}</span>
                        <span className="text-sm text-ink-muted">{key ? t(key) : row.effect}</span>
                      </li>
                    );
                  })}
                </ul>
                <Button
                  variant="danger"
                  // preview.granted is one value for the whole batch (this is
                  // either a grant call or a revoke call, never mixed), so a
                  // grant preview means every changing row is a NEW grant --
                  // frozen on an archived branch. A revoke preview is never
                  // blocked, matching the per-row button above.
                  disabled={
                    changing.length === 0 ||
                    change.isPending ||
                    (preview.granted && !effectivelyActive)
                  }
                  onClick={() => change.mutate(preview)}
                >
                  {change.isPending
                    ? t("common.loading")
                    : t("caps.apply_subtree", { count: changing.length })}
                </Button>
                {preview.granted && !effectivelyActive && (
                  <p className="text-xs text-ink-muted">{t("orgtree.archived_write_blocked")}</p>
                )}
                <p className="text-xs text-ink-muted">{t("caps.no_undo")}</p>
              </div>
            ))}
        </div>
      ) : (
        <p className="border-t border-hairline py-4 text-sm text-ink-muted">
          {t("caps.read_only")}
        </p>
      )}
    </Section>
  );
}
