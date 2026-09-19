import { useMutation } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { errorMessage } from "../../lib/errorMessage";
import { useI18n } from "../../lib/i18n";
import { nodeLabel, rankLabel } from "../../lib/orgLabels";
import type { OrgTreeNode, OrgTreeSeat } from "../../services/nodes";
import { hasRootSeat, managerSeatChoices } from "../../services/nodes";
import {
  applyOptionalPersonDetails,
  createPersonForSeat,
  type OptionalPersonWrite,
} from "../../services/people";
import { createPosition, seatPerson } from "../../services/positions";
import type { Rank } from "../../services/ranks";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Input, Label } from "../ui/Input";
import { Select } from "../ui/Select";
import {
  bankPatchOf,
  emptyPersonDraft,
  type PersonDraft,
  profilePatchOf,
} from "./PersonDetailsFields";
import { type OccupantMode, SeatOccupantFields } from "./SeatOccupantFields";

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  node: OrgTreeNode;
  nodes: OrgTreeNode[];
  ranks: Rank[];
  isAdmin: boolean;
  canMaintainProfile: boolean;
  canMaintainBank: boolean;
}

// The seat exists the moment createPosition resolves, whatever happens next —
// so a failure seating its occupant is shown next to a seat that is already
// real, never folded back into "creating the position failed".
type SeatResult =
  | { kind: "not_seated"; error: string }
  | { kind: "seated_partial"; name: string; code: string; failed: OptionalPersonWrite[] };

// THE OFFICE DOORWAY. The seat is created first — "Head of Marketing" exists,
// and stands empty until an account or a person is assigned to it. Underneath
// it is the same two records as the field doorway; only this door differs.
export function CreatePositionDialog(props: Props): JSX.Element | null {
  const {
    open,
    onClose,
    onCreated,
    node,
    nodes,
    ranks,
    isAdmin,
    canMaintainProfile,
    canMaintainBank,
  } = props;
  const { t, locale } = useI18n();

  const [title, setTitle] = useState("");
  const [titleEn, setTitleEn] = useState("");
  const [rankKey, setRankKey] = useState("");
  const [managerPositionId, setManagerPositionId] = useState("");
  const [occupantMode, setOccupantMode] = useState<OccupantMode>("none");
  const [occupantPersonId, setOccupantPersonId] = useState("");
  const [occupantDraft, setOccupantDraft] = useState<PersonDraft>(emptyPersonDraft);
  const [seatResult, setSeatResult] = useState<SeatResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choices: { seat: OrgTreeSeat; node: OrgTreeNode }[] = managerSeatChoices(nodes, node.id);
  const rootSeatFree = !hasRootSeat(nodes) && isAdmin;
  const manager = choices.find((choice) => choice.seat.position_id === managerPositionId);
  const availableRanks = manager
    ? ranks.filter((rank) => rank.ordinal >= manager.seat.rank_ordinal)
    : ranks;
  const rankValue = availableRanks.some((rank) => rank.key === rankKey) ? rankKey : "";
  const selectedRank = availableRanks.find((rank) => rank.key === rankValue);

  const reset = () => {
    setTitle("");
    setTitleEn("");
    setRankKey("");
    setManagerPositionId("");
    setOccupantMode("none");
    setOccupantPersonId("");
    setOccupantDraft(emptyPersonDraft);
    setSeatResult(null);
    setError(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  // onCreated() already ran when the position landed, so the tree behind the
  // dialog is fresh; closing only clears the form.
  const finish = () => {
    reset();
    onClose();
  };

  const create = useMutation({
    mutationFn: async () => {
      const position = await createPosition({
        nodeId: node.id,
        rankId: selectedRank?.id ?? "",
        title,
        titleEn,
        reportsToPositionId: managerPositionId || null,
      });
      let seat: SeatResult | null = null;
      try {
        if (occupantMode === "existing" && occupantPersonId) {
          await seatPerson({ positionId: position.id, personId: occupantPersonId });
        } else if (occupantMode === "new" && occupantDraft.fullName.trim()) {
          const created = await createPersonForSeat({
            positionId: position.id,
            fullName: occupantDraft.fullName,
            phone: occupantDraft.phone,
            email: occupantDraft.email,
            hireDate: occupantDraft.hireDate || null,
          });
          const failed = await applyOptionalPersonDetails(
            created.person_id,
            canMaintainProfile ? profilePatchOf(occupantDraft) : {},
            canMaintainBank ? bankPatchOf(occupantDraft) : {},
          );
          if (failed.length > 0) {
            seat = {
              kind: "seated_partial",
              name: occupantDraft.fullName.trim(),
              code: created.employee_code,
              failed,
            };
          }
        }
      } catch (e) {
        seat = { kind: "not_seated", error: errorMessage(e, t("orgtree.write_failed")) };
      }
      return seat;
    },
    onSuccess: (seat) => {
      setError(null);
      onCreated();
      if (seat) {
        setSeatResult(seat);
      } else {
        finish();
      }
    },
    onError: (e) => setError(errorMessage(e, t("orgtree.write_failed"))),
  });

  const canSubmit =
    title.trim() !== "" &&
    rankValue !== "" &&
    (managerPositionId !== "" || rootSeatFree) &&
    (occupantMode !== "existing" || occupantPersonId !== "") &&
    (occupantMode !== "new" || occupantDraft.fullName.trim() !== "") &&
    !create.isPending;

  if (!open) return null;

  if (seatResult) {
    return (
      <Dialog
        open={open}
        onClose={finish}
        title={t("position.created_title")}
        footer={<Button onClick={finish}>{t("common.close")}</Button>}
      >
        <div className="space-y-3">
          {seatResult.kind === "not_seated" ? (
            <>
              <Alert variant="success">{t("position.created_body", { title: title.trim() })}</Alert>
              <Alert variant="warning">
                {t("position.seat_not_assigned", { error: seatResult.error })}
              </Alert>
            </>
          ) : (
            <>
              <Alert variant="success">
                {t("field_worker.created_body", {
                  name: seatResult.name,
                  code: seatResult.code,
                })}
              </Alert>
              {seatResult.failed.includes("profile") && (
                <Alert variant="warning">{t("field_worker.profile_not_saved")}</Alert>
              )}
              {seatResult.failed.includes("bank") && (
                <Alert variant="warning">{t("field_worker.bank_not_saved")}</Alert>
              )}
            </>
          )}
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={t("position.title", { node: nodeLabel(node, locale) })}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={create.isPending}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => create.mutate()} disabled={!canSubmit}>
            {create.isPending ? t("common.loading") : t("position.submit")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-ink-muted">{t("position.hint")}</p>
        {error && <Alert variant="error">{error}</Alert>}

        <div>
          <Label htmlFor="position-title">{t("position.seat_title")}</Label>
          <Input
            id="position-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("position.seat_title_placeholder")}
            disabled={create.isPending}
          />
        </div>

        <div>
          <Label htmlFor="position-title-en">{t("position.seat_title_en")}</Label>
          <Input
            id="position-title-en"
            value={titleEn}
            onChange={(e) => setTitleEn(e.target.value)}
            disabled={create.isPending}
          />
        </div>

        <div>
          <Label htmlFor="position-manager">{t("seat.reports_to")}</Label>
          <Select
            id="position-manager"
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
          <Label htmlFor="position-rank">{t("seat.rank")}</Label>
          <Select
            id="position-rank"
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

        <div className="border-t border-hairline pt-4">
          <SeatOccupantFields
            mode={occupantMode}
            onModeChange={setOccupantMode}
            allowNone={true}
            personId={occupantPersonId}
            onPersonIdChange={setOccupantPersonId}
            excludePersonIds={[]}
            draft={occupantDraft}
            onDraftChange={(patch) => setOccupantDraft((prev) => ({ ...prev, ...patch }))}
            canMaintainProfile={canMaintainProfile}
            canMaintainBank={canMaintainBank}
            disabled={create.isPending}
            idPrefix="position-occupant"
          />
        </div>
      </div>
    </Dialog>
  );
}
