import { useQuery } from "@tanstack/react-query";
import type { JSX } from "react";
import { errorMessage } from "../../lib/errorMessage";
import { useI18n } from "../../lib/i18n";
import { listVisiblePersons } from "../../services/people";
import { Button } from "../ui/Button";
import { Empty, ErrorState } from "../ui/EmptyState";
import { Label } from "../ui/Input";
import { Select } from "../ui/Select";
import { ListSkeleton } from "../ui/Skeleton";
import { PersonDetailsFields, type PersonDraft } from "./PersonDetailsFields";

export type OccupantMode = "none" | "existing" | "new";

interface Props {
  mode: OccupantMode;
  onModeChange: (mode: OccupantMode) => void;
  allowNone: boolean;
  personId: string;
  onPersonIdChange: (id: string) => void;
  excludePersonIds: string[];
  draft: PersonDraft;
  onDraftChange: (patch: Partial<PersonDraft>) => void;
  canMaintainProfile: boolean;
  canMaintainBank: boolean;
  disabled: boolean;
  idPrefix: string;
}

// The existing-person / new-person toggle shared by every doorway that seats
// someone: AssignSeatDialog (an occupied or vacant seat, never left mid-dialog
// unassigned) and CreatePositionDialog (a brand-new seat, where "leave it
// empty" is also a valid choice).
export function SeatOccupantFields(props: Props): JSX.Element {
  const {
    mode,
    onModeChange,
    allowNone,
    personId,
    onPersonIdChange,
    excludePersonIds,
    draft,
    onDraftChange,
    canMaintainProfile,
    canMaintainBank,
    disabled,
    idPrefix,
  } = props;
  const { t } = useI18n();

  const persons = useQuery({
    queryKey: ["org", "persons"],
    queryFn: listVisiblePersons,
    enabled: mode === "existing",
  });

  const candidates = (persons.data ?? []).filter(
    (person) => person.status !== "departed" && !excludePersonIds.includes(person.id),
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {allowNone && (
          <Button
            size="sm"
            variant={mode === "none" ? "primary" : "secondary"}
            onClick={() => onModeChange("none")}
            disabled={disabled}
          >
            {t("assign.mode_none")}
          </Button>
        )}
        <Button
          size="sm"
          variant={mode === "existing" ? "primary" : "secondary"}
          onClick={() => onModeChange("existing")}
          disabled={disabled}
        >
          {t("assign.mode_existing")}
        </Button>
        <Button
          size="sm"
          variant={mode === "new" ? "primary" : "secondary"}
          onClick={() => onModeChange("new")}
          disabled={disabled}
        >
          {t("assign.mode_new")}
        </Button>
      </div>

      {mode === "existing" &&
        (persons.isLoading ? (
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
            <Label htmlFor={`${idPrefix}-person`}>{t("assign.person")}</Label>
            <Select
              id={`${idPrefix}-person`}
              value={personId}
              onChange={onPersonIdChange}
              disabled={disabled}
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
        ))}

      {mode === "new" && (
        <PersonDetailsFields
          draft={draft}
          onChange={onDraftChange}
          canMaintainProfile={canMaintainProfile}
          canMaintainBank={canMaintainBank}
          disabled={disabled}
          idPrefix={idPrefix}
        />
      )}
    </div>
  );
}
