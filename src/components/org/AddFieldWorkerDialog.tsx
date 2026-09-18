import { useMutation } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { errorMessage } from "../../lib/errorMessage";
import { useI18n } from "../../lib/i18n";
import { nodeLabel, rankLabel } from "../../lib/orgLabels";
import type { OrgTreeNode, OrgTreeSeat } from "../../services/nodes";
import { hasRootSeat, managerSeatChoices } from "../../services/nodes";
import {
  addFieldWorker,
  applyOptionalPersonDetails,
  type OptionalPersonWrite,
} from "../../services/people";
import type { Rank } from "../../services/positions";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Label } from "../ui/Input";
import {
  bankPatchOf,
  emptyPersonDraft,
  PersonDetailsFields,
  type PersonDraft,
  profilePatchOf,
} from "./PersonDetailsFields";
import { TouchSelect } from "./TouchSelect";

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  node: OrgTreeNode;
  nodes: OrgTreeNode[];
  ranks: Rank[];
  canMaintainProfile: boolean;
  canMaintainBank: boolean;
  isAdmin: boolean;
}

// The FLOOR doorway. One action creates the worker and their seat, and the
// seat is named after them. The line lead taps it; there is no separate
// "create a position" step and no account to invite.
export function AddFieldWorkerDialog(props: Props): JSX.Element | null {
  const {
    open,
    onClose,
    onCreated,
    node,
    nodes,
    ranks,
    canMaintainProfile,
    canMaintainBank,
    isAdmin,
  } = props;
  const { t, locale } = useI18n();

  const [draft, setDraft] = useState<PersonDraft>(emptyPersonDraft);
  const [rankKey, setRankKey] = useState("");
  const [managerPositionId, setManagerPositionId] = useState("");
  const [created, setCreated] = useState<{
    employeeCode: string;
    failed: OptionalPersonWrite[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choices: { seat: OrgTreeSeat; node: OrgTreeNode }[] = managerSeatChoices(nodes, node.id);
  const rootSeatFree = !hasRootSeat(nodes) && isAdmin;
  const manager = choices.find((choice) => choice.seat.position_id === managerPositionId);

  // A manager's rank may never sit below their report's, and the database
  // refuses the write. Offering only the ranks that can pass turns a guaranteed
  // error into a shorter list.
  const availableRanks = manager
    ? ranks.filter((rank) => rank.ordinal >= manager.seat.rank_ordinal)
    : ranks;
  const rankValue = availableRanks.some((rank) => rank.key === rankKey) ? rankKey : "";

  const reset = () => {
    setDraft(emptyPersonDraft);
    setRankKey("");
    setManagerPositionId("");
    setCreated(null);
    setError(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  // onCreated() already ran when the write landed, so the tree behind the
  // dialog is fresh; closing only clears the form.
  const finish = () => {
    reset();
    onClose();
  };

  const create = useMutation({
    mutationFn: async () => {
      const result = await addFieldWorker({
        nodeId: node.id,
        fullName: draft.fullName,
        rankKey: rankValue,
        reportsToPositionId: managerPositionId || null,
        phone: draft.phone,
        email: draft.email,
        hireDate: draft.hireDate || null,
      });
      // The person and the seat exist from here on, and the employee code is
      // permanent. The photo and the bank row need capabilities this caller
      // may not hold, so they are applied separately and reported separately —
      // never by re-running the call above, which would burn a second code.
      const failed = await applyOptionalPersonDetails(
        result.person_id,
        canMaintainProfile ? profilePatchOf(draft) : {},
        canMaintainBank ? bankPatchOf(draft) : {},
      );
      return { employeeCode: result.employee_code, failed };
    },
    onSuccess: (result) => {
      setError(null);
      setCreated(result);
      onCreated();
    },
    onError: (e) => setError(errorMessage(e, t("orgtree.write_failed"))),
  });

  const canSubmit =
    draft.fullName.trim() !== "" &&
    rankValue !== "" &&
    (managerPositionId !== "" || rootSeatFree) &&
    !create.isPending;

  if (!open) return null;

  if (created) {
    return (
      <Dialog
        open={open}
        onClose={finish}
        title={t("field_worker.created_title")}
        footer={<Button onClick={finish}>{t("common.close")}</Button>}
      >
        <div className="space-y-3">
          <Alert variant="success">
            {t("field_worker.created_body", {
              name: draft.fullName.trim(),
              code: created.employeeCode,
            })}
          </Alert>
          {created.failed.includes("profile") && (
            <Alert variant="warning">{t("field_worker.profile_not_saved")}</Alert>
          )}
          {created.failed.includes("bank") && (
            <Alert variant="warning">{t("field_worker.bank_not_saved")}</Alert>
          )}
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={t("field_worker.title", { node: nodeLabel(node, locale) })}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={create.isPending}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => create.mutate()} disabled={!canSubmit}>
            {create.isPending ? t("common.loading") : t("field_worker.submit")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-ink-muted">{t("field_worker.hint")}</p>
        {error && <Alert variant="error">{error}</Alert>}

        <PersonDetailsFields
          draft={draft}
          onChange={(patch) => setDraft((prev) => ({ ...prev, ...patch }))}
          canMaintainProfile={canMaintainProfile}
          canMaintainBank={canMaintainBank}
          disabled={create.isPending}
          idPrefix="field-worker"
        />

        <div className="border-t border-hairline pt-4">
          <Label htmlFor="field-worker-manager">{t("seat.reports_to")}</Label>
          <TouchSelect
            id="field-worker-manager"
            value={managerPositionId}
            onChange={(value) => setManagerPositionId(value)}
            disabled={create.isPending}
            searchable={choices.length >= 6}
            ariaLabel={t("seat.reports_to")}
            options={[
              {
                value: "",
                label: rootSeatFree ? t("seat.no_manager_root") : t("seat.pick_manager"),
              },
              ...choices.map(({ seat, node: seatNode }) => ({
                value: seat.position_id,
                label: `${seat.title} · ${nodeLabel(seatNode, locale)}${
                  seat.person_name ? ` — ${seat.person_name}` : ""
                }`,
              })),
            ]}
          />
          {choices.length === 0 && !rootSeatFree && (
            <p className="mt-1 text-xs text-danger-text">{t("seat.no_manager_available")}</p>
          )}
        </div>

        <div>
          <Label htmlFor="field-worker-rank">{t("seat.rank")}</Label>
          <TouchSelect
            id="field-worker-rank"
            value={rankValue}
            onChange={(value) => setRankKey(value)}
            disabled={create.isPending}
            ariaLabel={t("seat.rank")}
            options={[
              { value: "", label: t("seat.pick_rank") },
              ...availableRanks.map((rank) => ({
                value: rank.key,
                label: rankLabel(rank, locale),
              })),
            ]}
          />
          {manager && availableRanks.length < ranks.length && (
            <p className="mt-1 text-xs text-ink-muted">
              {t("seat.rank_filtered", { title: manager.seat.title })}
            </p>
          )}
        </div>
      </div>
    </Dialog>
  );
}
