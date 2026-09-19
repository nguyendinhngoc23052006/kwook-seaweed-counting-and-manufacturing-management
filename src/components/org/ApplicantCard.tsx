import { useQuery } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { useT } from "../../lib/i18n";
import { getApplicationDetail, type JobApplication } from "../../services/jobApplications";
import { Button } from "../ui/Button";
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
  const [open, setOpen] = useState(false);

  const detail = useQuery({
    queryKey: ["jobs", "applicant", a.id],
    queryFn: () => getApplicationDetail(a.id),
    enabled: open,
  });

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
    </article>
  );
}
