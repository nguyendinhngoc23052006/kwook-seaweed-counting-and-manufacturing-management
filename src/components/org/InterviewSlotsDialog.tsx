import { useMutation, useQuery } from "@tanstack/react-query";
import { type JSX, useEffect, useState } from "react";
import { errorMessage } from "../../lib/errorMessage";
import { useI18n } from "../../lib/i18n";
import { queryClient } from "../../lib/query";
import {
  addInterviewSlots,
  adminInterviewSlots,
  type InterviewSlotDraft,
} from "../../services/interviewSlots";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Empty, ErrorState } from "../ui/EmptyState";
import { Input, Label } from "../ui/Input";
import { Pill } from "../ui/Pill";
import { Section } from "../ui/Section";
import { ListSkeleton } from "../ui/Skeleton";

interface Props {
  postingId: string;
  open: boolean;
  onClose: () => void;
}

// A row's own id is UI-only -- it lets React key an add/remove list stably and
// never reaches the RPC, which takes plain starts_at/ends_at/capacity.
interface DraftRow {
  key: string;
  startsAt: string;
  endsAt: string;
  capacity: string;
}

let nextKey = 0;
function emptyRow(): DraftRow {
  nextKey += 1;
  return { key: `row-${nextKey}`, startsAt: "", endsAt: "", capacity: "1" };
}

function toDraft(row: DraftRow): InterviewSlotDraft | null {
  if (!row.startsAt || !row.endsAt) return null;
  const startsAt = new Date(row.startsAt).toISOString();
  const endsAt = new Date(row.endsAt).toISOString();
  const capacity = Number(row.capacity);
  if (!Number.isFinite(capacity) || capacity < 1) return null;
  if (endsAt <= startsAt) return null;
  return { startsAt, endsAt, capacity };
}

// The admin side of interview scheduling: add any number of time-range slots
// for a posting, and see who has already booked into each. Candidate-facing
// booking is org_book_interview_slot(), a separate anonymous flow -- this
// dialog only ever reads bookings, never writes them.
export function InterviewSlotsDialog(props: Props): JSX.Element | null {
  const { postingId, open, onClose } = props;
  const { t } = useI18n();

  const [rows, setRows] = useState<DraftRow[]>([emptyRow()]);
  const [error, setError] = useState<string | null>(null);

  // The dialog never unmounts between postings, so a draft would otherwise
  // survive Close and reappear under the next posting opened.
  useEffect(() => {
    if (!open) return;
    setRows([emptyRow()]);
    setError(null);
  }, [open]);

  const slots = useQuery({
    queryKey: ["org", "interviewSlots", postingId],
    queryFn: () => adminInterviewSlots(postingId),
    enabled: open,
  });

  const addRows = useMutation({
    mutationFn: (drafts: InterviewSlotDraft[]) => addInterviewSlots(postingId, drafts),
    onSuccess: () => {
      setRows([emptyRow()]);
      queryClient.invalidateQueries({ queryKey: ["org", "interviewSlots", postingId] });
    },
    onError: (e) => setError(errorMessage(e, t("interviews.save_failed"))),
  });

  const setRow = (key: string, patch: Partial<DraftRow>) =>
    setRows((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const removeRow = (key: string) =>
    setRows((prev) => (prev.length > 1 ? prev.filter((row) => row.key !== key) : prev));

  const drafts = rows.map(toDraft);
  const ready = drafts.length > 0 && drafts.every((d) => d !== null);

  if (!open) return null;

  return (
    <Dialog open={open} onClose={onClose} title={t("interviews.title")}>
      <div className="space-y-5">
        {error && <Alert variant="error">{error}</Alert>}

        <Section title={t("interviews.add_slots")} description={t("interviews.add_slots_hint")}>
          <div className="space-y-3 py-2">
            {rows.map((row, i) => {
              const invalid = row.startsAt !== "" && row.endsAt !== "" && toDraft(row) === null;
              return (
                <div key={row.key} className="rounded-lg border border-hairline p-3">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div>
                      <Label htmlFor={`slot-start-${row.key}`}>{t("interviews.starts_at")}</Label>
                      <Input
                        id={`slot-start-${row.key}`}
                        type="datetime-local"
                        value={row.startsAt}
                        onChange={(e) => setRow(row.key, { startsAt: e.target.value })}
                        disabled={addRows.isPending}
                      />
                    </div>
                    <div>
                      <Label htmlFor={`slot-end-${row.key}`}>{t("interviews.ends_at")}</Label>
                      <Input
                        id={`slot-end-${row.key}`}
                        type="datetime-local"
                        value={row.endsAt}
                        onChange={(e) => setRow(row.key, { endsAt: e.target.value })}
                        disabled={addRows.isPending}
                      />
                    </div>
                    <div>
                      <Label htmlFor={`slot-capacity-${row.key}`}>{t("interviews.capacity")}</Label>
                      <Input
                        id={`slot-capacity-${row.key}`}
                        type="number"
                        min="1"
                        value={row.capacity}
                        onChange={(e) => setRow(row.key, { capacity: e.target.value })}
                        disabled={addRows.isPending}
                      />
                    </div>
                  </div>
                  {invalid && (
                    <p className="mt-2 text-xs text-danger-text">{t("interviews.row_invalid")}</p>
                  )}
                  {rows.length > 1 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="mt-2"
                      onClick={() => removeRow(row.key)}
                      disabled={addRows.isPending}
                    >
                      {t("interviews.remove_row", { n: i + 1 })}
                    </Button>
                  )}
                </div>
              );
            })}

            <Button
              variant="secondary"
              size="sm"
              onClick={() => setRows((prev) => [...prev, emptyRow()])}
              disabled={addRows.isPending}
            >
              {t("interviews.add_another")}
            </Button>

            <div className="flex justify-end">
              <Button
                onClick={() => addRows.mutate(drafts as InterviewSlotDraft[])}
                disabled={!ready || addRows.isPending}
              >
                {addRows.isPending ? t("common.loading") : t("interviews.save_slots")}
              </Button>
            </div>
          </div>
        </Section>

        <Section title={t("interviews.existing_slots")}>
          <div className="py-2">
            {slots.isLoading ? (
              <ListSkeleton rows={2} label={t("interviews.loading")} />
            ) : slots.isError ? (
              <ErrorState
                message={errorMessage(slots.error, t("interviews.load_failed"))}
                action={
                  <Button size="sm" onClick={() => slots.refetch()}>
                    {t("common.retry")}
                  </Button>
                }
              />
            ) : (slots.data ?? []).length === 0 ? (
              <Empty title={t("interviews.no_slots")} description={t("interviews.no_slots_hint")} />
            ) : (
              <ul className="space-y-3">
                {(slots.data ?? []).map((slot) => (
                  <li key={slot.id} className="rounded-lg border border-hairline p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-medium text-ink">
                        {new Date(slot.starts_at).toLocaleString()} –{" "}
                        {new Date(slot.ends_at).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </p>
                      <Pill tone={slot.booked.length >= slot.capacity ? "warning" : "neutral"}>
                        {t("interviews.booked_of_capacity", {
                          booked: slot.booked.length,
                          capacity: slot.capacity,
                        })}
                      </Pill>
                    </div>
                    {slot.booked.length > 0 && (
                      <ul className="mt-2 space-y-1 text-sm text-ink-muted">
                        {slot.booked.map((booking) => (
                          <li key={booking.application_id}>{booking.full_name}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Section>
      </div>
    </Dialog>
  );
}
