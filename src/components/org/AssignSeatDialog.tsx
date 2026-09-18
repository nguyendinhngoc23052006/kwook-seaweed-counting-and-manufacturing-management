import { useMutation, useQuery } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { errorMessage } from "../../lib/errorMessage";
import { useI18n } from "../../lib/i18n";
import { nodeLabel } from "../../lib/orgLabels";
import type { OrgTreeNode, OrgTreeSeat } from "../../services/nodes";
import {
  applyOptionalPersonDetails,
  createPersonForSeat,
  listVisiblePersons,
} from "../../services/people";
import { seatPerson, vacatePosition } from "../../services/positions";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Empty, ErrorState } from "../ui/EmptyState";
import { Label } from "../ui/Input";
import { ListSkeleton } from "../ui/Skeleton";
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
  onDone: () => void;
  seat: OrgTreeSeat;
  node: OrgTreeNode;
  canMaintainProfile: boolean;
  canMaintainBank: boolean;
  myPersonId: string | null;
}

type Mode = "existing" | "new";

// Fills an empty seat, replaces its holder, or vacates it. Every one of those
// is one appended row on the holder timeline — nothing is overwritten, so last
// September stays answerable.
export function AssignSeatDialog(props: Props): JSX.Element | null {
  const { open, onClose, onDone, seat, node, canMaintainProfile, canMaintainBank, myPersonId } =
    props;
  const { t, locale } = useI18n();

  const [mode, setMode] = useState<Mode>("existing");
  const [personId, setPersonId] = useState("");
  const [draft, setDraft] = useState<PersonDraft>(emptyPersonDraft);
  const [confirmVacate, setConfirmVacate] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const persons = useQuery({
    queryKey: ["org", "persons"],
    queryFn: listVisiblePersons,
    enabled: open && mode === "existing",
  });

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

  // The database refuses self-seating outright, and a person already seated
  // outside the caller's branch too — so neither is offered here.
  const candidates = (persons.data ?? []).filter(
    (person) =>
      person.status !== "departed" && person.id !== myPersonId && person.id !== seat.person_id,
  );

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

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={mode === "existing" ? "primary" : "secondary"}
            onClick={() => setMode("existing")}
            disabled={busy}
          >
            {t("assign.mode_existing")}
          </Button>
          <Button
            size="sm"
            variant={mode === "new" ? "primary" : "secondary"}
            onClick={() => setMode("new")}
            disabled={busy}
          >
            {t("assign.mode_new")}
          </Button>
        </div>

        {mode === "existing" ? (
          persons.isLoading ? (
            <ListSkeleton rows={2} label={t("assign.loading_people")} />
          ) : persons.isError ? (
            <ErrorState
              message={errorMessage(persons.error, t("assign.people_failed"))}
              action={
                <Button size="sm" onClick={() => persons.refetch()}>
                  {t("common.retry")}
                </Button>
              }
            />
          ) : candidates.length === 0 ? (
            <Empty title={t("assign.no_candidates")} description={t("assign.no_candidates_hint")} />
          ) : (
            <div>
              <Label htmlFor="assign-person">{t("assign.person")}</Label>
              <TouchSelect
                id="assign-person"
                value={personId}
                onChange={(value) => setPersonId(value)}
                disabled={busy}
                searchable={candidates.length >= 6}
                ariaLabel={t("assign.person")}
                options={[
                  { value: "", label: t("assign.pick_person") },
                  ...candidates.map((person) => ({
                    value: person.id,
                    label: `${person.full_name} · ${person.employee_code}`,
                  })),
                ]}
              />
            </div>
          )
        ) : (
          <PersonDetailsFields
            draft={draft}
            onChange={(patch) => setDraft((prev) => ({ ...prev, ...patch }))}
            canMaintainProfile={canMaintainProfile}
            canMaintainBank={canMaintainBank}
            disabled={busy}
            idPrefix="assign-new"
          />
        )}
      </div>
    </Dialog>
  );
}
