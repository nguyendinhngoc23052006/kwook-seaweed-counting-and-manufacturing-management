import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { errorMessage } from "../../lib/errorMessage";
import { useT } from "../../lib/i18n";
import {
  advanceApplication,
  applicationNextStates,
  getApplicationDetail,
  type JobApplication,
  type JobApplicationState,
} from "../../services/jobApplications";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Input, Label } from "../ui/Input";
import { Pill } from "../ui/Pill";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-ink-faint">{label}</dt>
      <dd className="text-sm text-ink">{value}</dd>
    </div>
  );
}

function Answer({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-ink-faint">{label}</dt>
      <dd className="whitespace-pre-line text-sm leading-relaxed text-ink-muted">{value}</dd>
    </div>
  );
}

// One applicant. The long answers are not in the list -- they are fetched here,
// once, when this card is actually opened, so a posting with six hundred
// applicants stays a list of names rather than megabytes of prose.
export function ApplicantCard({ a }: { a: JobApplication }): JSX.Element {
  const t = useT();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ["jobs", "applicant", a.id],
    queryFn: () => getApplicationDetail(a.id),
    enabled: open,
  });

  // The funnel's shape is the database's (org_application_next_states), asked
  // for rather than copied: a second rulebook in the client would drift, and
  // the RPC refuses anything the first one does not allow regardless.
  const next = useQuery({
    queryKey: ["jobs", "next-states", a.state],
    queryFn: () => applicationNextStates(a.state),
  });

  const advance = useMutation({
    mutationFn: (state: JobApplicationState) =>
      advanceApplication({ applicationId: a.id, state, note }),
    onSuccess: () => {
      setError(null);
      setNote("");
      queryClient.invalidateQueries({ queryKey: ["jobs", "applications"] });
      queryClient.invalidateQueries({ queryKey: ["jobs", "closed-applications"] });
      queryClient.invalidateQueries({ queryKey: ["jobs", "closed-applications-count"] });
      queryClient.invalidateQueries({ queryKey: ["jobs", "application-counts"] });
    },
    onError: (e) => setError(errorMessage(e, t("applicants.advance_failed"))),
  });

  const moves = next.data ?? [];
  // Turning somebody down is the one move that owes a reason, and the database
  // refuses it without one -- so the field appears only when it is needed.
  const needsNote = (state: JobApplicationState) => state === "not_selected";

  return (
    <article className="rounded-lg border border-hairline bg-surface-raised p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="min-w-0 flex-1 font-medium text-ink">{a.full_name}</h2>
        <div className="flex flex-wrap gap-2">
          {a.score !== null && (
            <Pill tone="accent">{t("applicants.score", { score: a.score })}</Pill>
          )}
          <Pill>{t(`applicants.state_${a.state}`)}</Pill>
        </div>
      </div>

      {error && (
        <Alert variant="error" className="mt-2">
          {error}
        </Alert>
      )}

      <dl className="mt-2 grid gap-2 sm:grid-cols-3">
        <Field label={t("apply.phone")} value={a.phone} />
        <Field label={t("apply.email")} value={a.email} />
        <Field
          label={t("apply.years")}
          value={
            a.years_experience === null ? t("applicants.not_given") : String(a.years_experience)
          }
        />
      </dl>

      {a.has_writing && (
        <>
          <Button size="sm" variant="ghost" className="mt-2" onClick={() => setOpen(!open)}>
            {open ? t("applicants.hide") : t("applicants.read")}
          </Button>
          {open && (
            <div className="mt-2 space-y-3 rounded-md bg-surface-muted p-3">
              {a.current_job && <Field label={t("apply.current_job")} value={a.current_job} />}
              {detail.isLoading && <p className="text-sm text-ink-muted">{t("common.loading")}</p>}
              {detail.isError && (
                <p className="text-sm text-danger-text">{t("applicants.detail_failed")}</p>
              )}
              {detail.data?.portfolio_url && (
                <div>
                  <dt className="text-xs text-ink-faint">{t("apply.portfolio")}</dt>
                  <dd className="text-sm">
                    <a
                      href={detail.data.portfolio_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary-text hover:underline"
                    >
                      {detail.data.portfolio_url}
                    </a>
                  </dd>
                </div>
              )}
              {detail.data?.cv_flagged && (
                <div className="rounded-md bg-warning-subtle p-2">
                  <dt className="text-xs font-medium text-warning-text">
                    {t("applicants.cv_warning")}
                  </dt>
                  <dd className="mt-1 text-sm text-warning-text">
                    {detail.data.cv_scan_note || t("applicants.cv_warning_no_note")}
                  </dd>
                </div>
              )}
              {detail.data?.why_this_job && (
                <Answer label={t("apply.why")} value={detail.data.why_this_job} />
              )}
              {detail.data?.cv_text && (
                <Answer label={t("apply.experience")} value={detail.data.cv_text} />
              )}
              {/* The CV-scoring Edge Function's own reasoning, per criterion --
                  computed today, fetched today, but never rendered until now. */}
              {detail.data?.score_reasoning && detail.data.score_reasoning.length > 0 && (
                <div>
                  <dt className="text-xs text-ink-faint">{t("applicants.why_this_score")}</dt>
                  <dd className="mt-1 space-y-1 text-sm leading-relaxed text-ink-muted">
                    {detail.data.score_reasoning.map((item, i) => (
                      <div key={i}>
                        <span className="font-semibold text-ink">{item.criterion}</span> {item.note}
                      </div>
                    ))}
                  </dd>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {moves.length > 0 && (
        <div className="mt-3 border-t border-border pt-3">
          {moves.some(needsNote) && (
            <div className="mb-2">
              <Label htmlFor={`applicant-note-${a.id}`}>{t("applicants.reason")}</Label>
              <Input
                id={`applicant-note-${a.id}`}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={t("applicants.reason_placeholder")}
                disabled={advance.isPending}
              />
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {moves.map((state) => (
              <Button
                key={state}
                size="sm"
                variant={
                  state === "hired"
                    ? "primary"
                    : state === "not_selected" || state === "withdrawn"
                      ? "danger"
                      : "secondary"
                }
                disabled={advance.isPending || (needsNote(state) && note.trim().length < 3)}
                onClick={() => advance.mutate(state)}
              >
                {t(`applicants.move_${state}`)}
              </Button>
            ))}
          </div>
        </div>
      )}
    </article>
  );
}
