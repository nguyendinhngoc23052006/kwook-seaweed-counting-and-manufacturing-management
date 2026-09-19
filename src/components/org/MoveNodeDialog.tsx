import { useMutation } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { errorMessage } from "../../lib/errorMessage";
import { useI18n } from "../../lib/i18n";
import { nodeLabel } from "../../lib/orgLabels";
import {
  breadcrumbOf,
  descendantIds,
  indexChildren,
  isNodeEffectivelyActive,
  moveNode,
  type OrgTreeNode,
} from "../../services/nodes";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Label } from "../ui/Input";
import { Select } from "../ui/Select";

interface Props {
  open: boolean;
  onClose: () => void;
  onMoved: () => void;
  node: OrgTreeNode;
  nodes: OrgTreeNode[];
}

// org_guard_nodes (8.8, 20260920000000_org_foundation.sql:1204) reserves a real
// parent_id change to org_admin(); this dialog is only reachable via NodePage's
// isAdmin-gated "Move" button, so the server refusal is a backstop, not the
// primary gate. The node's own subtree is excluded from the picker below so a
// doomed cycle is not even offerable, though the trigger would refuse it anyway.
export function MoveNodeDialog(props: Props): JSX.Element | null {
  const { open, onClose, onMoved, node, nodes } = props;
  const { t, locale } = useI18n();

  const [parentId, setParentId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setParentId("");
    setError(null);
    onClose();
  };

  const childIndex = indexChildren(nodes);
  const excluded = new Set([node.id, ...descendantIds(childIndex, node.id)]);
  const choices = nodes.filter((n) => !excluded.has(n.id));

  const move = useMutation({
    mutationFn: () => moveNode(node.id, parentId),
    onSuccess: () => {
      onMoved();
      close();
    },
    onError: (e) => setError(errorMessage(e, t("orgtree.write_failed"))),
  });

  if (!open) return null;

  return (
    <Dialog
      open={open}
      onClose={close}
      title={t("orgtree.move_title", { node: nodeLabel(node, locale) })}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={move.isPending}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => move.mutate()} disabled={!parentId || move.isPending}>
            {move.isPending ? t("common.loading") : t("orgtree.move_submit")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-ink-muted">{t("orgtree.move_hint")}</p>
        {error && <Alert variant="error">{error}</Alert>}

        <div>
          <Label htmlFor="move-parent">{t("orgtree.move_new_parent")}</Label>
          <Select
            id="move-parent"
            value={parentId}
            onChange={(value) => setParentId(value)}
            disabled={move.isPending}
            searchable={choices.length >= 6}
            ariaLabel={t("orgtree.move_new_parent")}
            options={[
              { value: "", label: t("orgtree.pick_node") },
              // org_guard_nodes freezes a NEW parent that is effectively
              // inactive (20260924000000_freeze_inactive_subtrees.sql) --
              // kept in the list rather than dropped so an admin can still
              // see the branch exists and why it's unavailable, per
              // Select's per-option disabled support.
              ...choices.map((choice) => {
                const choiceActive = isNodeEffectivelyActive(nodes, choice.id);
                const label = breadcrumbOf(nodes, choice.id)
                  .map((step) => nodeLabel(step, locale))
                  .join(" / ");
                return {
                  value: choice.id,
                  label: choiceActive ? label : `${label} ${t("orgtree.archived_suffix")}`,
                  disabled: !choiceActive,
                };
              }),
            ]}
          />
          {choices.length === 0 && (
            <p className="mt-1 text-xs text-danger-text">{t("orgtree.move_no_choices")}</p>
          )}
        </div>
      </div>
    </Dialog>
  );
}
