import { useMutation } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { errorMessage } from "../../lib/errorMessage";
import { useI18n } from "../../lib/i18n";
import { nodeLabel } from "../../lib/orgLabels";
import type { OrgTreeNode, OrgTreeSeat } from "../../services/nodes";
import { applyOptionalPersonDetails, createPersonForSeat } from "../../services/people";
import { seatPerson, vacatePosition } from "../../services/positions";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
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
  onDone: () => void;
  seat: OrgTreeSeat;
  node: OrgTreeNode;
  canMaintainProfile: boolean;
  canMaintainBank: boolean;
  myPersonId: string | null;
}

// Fills an empty seat, replaces its holder, or vacates it. Every one of those
// is one appended row on the holder timeline — nothing is overwritten, so last
// September stays answerable.
export function AssignSeatDialog(props: Props): JSX.Element | null {
  const { open, onClose, onDone, seat, node, canMaintainProfile, canMaintainBank, myPersonId } =
    props;
  const { t, locale } = useI18n();

  const [mode, setMode] = useState<OccupantMode>("existing");
  const [personId, setPersonId] = useState("");
  const [draft, setDraft] = useState<PersonDraft>(emptyPersonDraft);
  const [confirmVacate, setConfirmVacate] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setMode("existing");
    setPersonId("");
    setDraft(emptyPersonDraft);
    setConfirmVacate(false);
    setError(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  const finish = () => {
    reset();
    onDone();
    onClose();
  };

  const assignExisting = useMutation({
    mutationFn: () => seatPerson({ positionId: seat.position_id, personId }),
    onSuccess: finish,
    onError: (e) => setError(errorMessage(e, t("orgtree.write_failed"))),
  });

  const vacate = useMutation({
    mutationFn: () => vacatePosition(seat.position_id),
    onSuccess: finish,
    onError: (e) => setError(errorMessage(e, t("orgtree.write_failed"))),
  });

  const createAndAssign = useMutation({
    mutationFn: async () => {
      const result = await createPersonForSeat({
        positionId: seat.position_id,
        fullName: draft.fullName,
        phone: draft.phone,
        email: draft.email,
        hireDate: draft.hireDate || null,
      });
      const failed = await applyOptionalPersonDetails(
        result.person_id,
        canMaintainProfile ? profilePatchOf(draft) : {},
        canMaintainBank ? bankPatchOf(draft) : {},
      );
      return failed;
    },
    onSuccess: (failed) => {
      // The person exists and is seated whatever happened next, so a failed
      // optional half is said out loud rather than closed over — and the call
      // above is never repeated, because it issues a permanent employee code.
      if (failed.length > 0) {
        setError(
          failed
            .map((step) =>
              step === "bank"
                ? t("field_worker.bank_not_saved")
                : t("field_worker.profile_not_saved"),
            )
            .join(" "),
        );
        onDone();
        return;
      }
      finish();
    },
    onError: (e) => setError(errorMessage(e, t("orgtree.write_failed"))),
  });

  const busy = assignExisting.isPending || vacate.isPending || createAndAssign.isPending;

  if (!open) return null;

  return (
    <Dialog
      open={open}
      onClose={close}
      title={t("assign.title", { seat: seat.title })}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            {t("common.cancel")}
          </Button>
          {mode === "existing" ? (
            <Button onClick={() => assignExisting.mutate()} disabled={!personId || busy}>
              {assignExisting.isPending ? t("common.loading") : t("assign.submit")}
            </Button>
          ) : (
            <Button
              onClick={() => createAndAssign.mutate()}
              disabled={draft.fullName.trim() === "" || busy}
            >
              {createAndAssign.isPending ? t("common.loading") : t("assign.create_and_submit")}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-ink-muted">
          {t("assign.context", {
            seat: seat.title,
            node: nodeLabel(node, locale),
          })}
        </p>

        {error && <Alert variant="error">{error}</Alert>}

        {seat.person_id && (
          <div className="rounded-lg border border-hairline bg-surface-muted p-3">
            <p className="text-sm text-ink">
              {t("assign.current_holder", {
                name: seat.person_name ?? "",
                code: seat.employee_code ?? "",
              })}
            </p>
            {confirmVacate ? (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="danger" size="sm" onClick={() => vacate.mutate()} disabled={busy}>
                  {vacate.isPending ? t("common.loading") : t("assign.vacate_confirm")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmVacate(false)}
                  disabled={busy}
                >
                  {t("common.cancel")}
                </Button>
              </div>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                className="mt-3"
                onClick={() => setConfirmVacate(true)}
                disabled={busy}
              >
                {t("assign.vacate")}
              </Button>
            )}
          </div>
        )}

        {/* The database refuses self-seating outright, and a person already
            seated elsewhere too — so neither is offered here. */}
        <SeatOccupantFields
          mode={mode}
          onModeChange={setMode}
          allowNone={false}
          personId={personId}
          onPersonIdChange={setPersonId}
          excludePersonIds={[myPersonId, seat.person_id].filter((id): id is string => Boolean(id))}
          draft={draft}
          onDraftChange={(patch) => setDraft((prev) => ({ ...prev, ...patch }))}
          canMaintainProfile={canMaintainProfile}
          canMaintainBank={canMaintainBank}
          disabled={busy}
          idPrefix="assign"
        />
      </div>
    </Dialog>
  );
}
