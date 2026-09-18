import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { Link } from "react-router-dom";
import { JobPostingDialog } from "../../components/org/JobPostingDialog";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Empty, ErrorState } from "../../components/ui/EmptyState";
import { Input, Label } from "../../components/ui/Input";
import { Pill } from "../../components/ui/Pill";
import { Section } from "../../components/ui/Section";
import { ListSkeleton } from "../../components/ui/Skeleton";
import { endOfDayIso } from "../../lib/dates";
import { errorMessage } from "../../lib/errorMessage";
import { useI18n } from "../../lib/i18n";
import { getMyCapabilityReach } from "../../services/capabilities";
import { getApplicationCounts } from "../../services/jobApplications";
import {
  closeJob,
  discardDraftJob,
  extendJob,
  type JobPostingAdmin,
  type JobPostingState,
  listJobPostingsAdmin,
  publishJob,
} from "../../services/jobs";

type Dated = { kind: "publish" | "extend"; job: JobPostingAdmin } | null;

const TONE: Record<JobPostingState, "neutral" | "success" | "warning"> = {
  draft: "neutral",
  open: "success",
  closed: "warning",
  filled: "neutral",
};

// Where the thresholds live. They appear on exactly this screen and in no
// projection an applicant can reach.
export function JobPostingsPage(): JSX.Element {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<JobPostingAdmin | null>(null);
  const [composing, setComposing] = useState(false);
  const [dated, setDated] = useState<Dated>(null);
  const [date, setDate] = useState("");
  const [error, setError] = useState<string | null>(null);

  // The nav tab is hidden from the other 499 people, but a typed URL is not a
  // nav tab. org_job_postings_admin() answers a non-admin with an empty list
  // rather than an error, so without this the screen would read "No postings
  // yet" and offer a New button that fails only after the form is filled in.
  const reach = useQuery({
    queryKey: ["org", "reach"],
    queryFn: getMyCapabilityReach,
  });
  const isAdmin = reach.data?.isAdmin === true;

  const postings = useQuery({
    queryKey: ["jobs", "admin"],
    queryFn: listJobPostingsAdmin,
    enabled: isAdmin,
  });

  // One call for the whole desk rather than one per posting.
  const counts = useQuery({
    queryKey: ["jobs", "counts"],
    queryFn: getApplicationCounts,
    enabled: isAdmin,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["jobs"] });
    setDated(null);
    setDate("");
    setError(null);
  };

  const act = useMutation({
    mutationFn: (job: () => Promise<void>) => job(),
    onSuccess: refresh,
    onError: (e) => setError(errorMessage(e, t("jobs.action_failed"))),
  });

  if (reach.isLoading || (isAdmin && postings.isLoading)) {
    return <ListSkeleton rows={3} label={t("jobs.loading")} />;
  }
  if (!isAdmin) {
    return <Empty title={t("jobs.not_yours")} description={t("jobs.not_yours_hint")} />;
  }
  if (postings.isError) {
    return (
      <ErrorState
        message={errorMessage(postings.error, t("jobs.load_failed"))}
        action={<Button onClick={() => postings.refetch()}>{t("common.retry")}</Button>}
      />
    );
  }

  const rows = postings.data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink">{t("jobs.title")}</h1>
          <p className="text-sm leading-relaxed text-ink-muted">{t("jobs.subtitle")}</p>
        </div>
        <Button
          onClick={() => {
            setEditing(null);
            setComposing(true);
          }}
        >
          {t("jobs.new")}
        </Button>
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      {rows.length === 0 ? (
        <Empty title={t("jobs.empty")} description={t("jobs.empty_hint")} />
      ) : (
        <Section title={t("jobs.all")} description={t("jobs.all_hint")}>
          <div className="space-y-3 py-3">
            {rows.map((job) => (
              <article
                key={job.id}
                className="rounded-lg border border-hairline bg-surface-raised p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h3 className="min-w-0 flex-1 font-medium leading-snug text-ink">
                    {job.state === "open" ? (
                      // A plain anchor: the live posting lives on the public
                      // careers site, a separate sibling app/router entirely
                      // (see PublicJobsApp), not a route inside this one.
                      <a
                        href={`/careers/jobs/${job.id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-accent-text hover:underline"
                      >
                        {job.title}
                      </a>
                    ) : (
                      job.title
                    )}
                  </h3>
                  <Pill tone={TONE[job.state]}>{t(`jobs.state_${job.state}`)}</Pill>
                </div>

                <p className="mt-1 text-xs text-ink-faint">
                  {job.location} · {t("jobs.openings_n", { n: job.openings })}
                </p>

                <p className="mt-2 text-sm">
                  <Link
                    to={`/org/jobs/${job.id}/applications`}
                    className="text-accent-text hover:underline"
                  >
                    {counts.isSuccess
                      ? t("jobs.applicants_n", {
                          n: counts.data[job.id] ?? 0,
                        })
                      : t("jobs.applicants_unknown")}
                  </Link>
                </p>

                <p className="mt-2 text-xs text-ink-muted">
                  {t("jobs.bar_summary", {
                    auto: job.auto_advance_score,
                    min: job.min_score,
                    cap: job.invite_cap,
                  })}
                </p>

                <div className="mt-3 flex flex-wrap gap-2">
                  {job.state === "draft" && (
                    <>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={act.isPending}
                        onClick={() => {
                          setEditing(job);
                          setComposing(true);
                        }}
                      >
                        {t("common.edit")}
                      </Button>
                      <Button
                        size="sm"
                        disabled={act.isPending}
                        onClick={() => {
                          setDate("");
                          setDated({ kind: "publish", job });
                        }}
                      >
                        {t("jobs.publish")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={act.isPending}
                        onClick={() => act.mutate(() => discardDraftJob(job.id))}
                      >
                        {t("jobs.discard")}
                      </Button>
                    </>
                  )}
                  {job.state === "open" && (
                    <>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={act.isPending}
                        onClick={() => {
                          setDate("");
                          setDated({ kind: "extend", job });
                        }}
                      >
                        {t("jobs.extend")}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={act.isPending}
                        onClick={() => act.mutate(() => closeJob(job.id))}
                      >
                        {t("jobs.close")}
                      </Button>
                    </>
                  )}
                </div>
              </article>
            ))}
          </div>
        </Section>
      )}

      <JobPostingDialog
        open={composing}
        onClose={() => setComposing(false)}
        onSaved={refresh}
        editing={editing}
      />

      <Dialog
        open={dated !== null}
        onClose={() => setDated(null)}
        title={dated?.kind === "extend" ? t("jobs.extend_title") : t("jobs.publish_title")}
        footer={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setDated(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              disabled={!date || act.isPending}
              onClick={() =>
                dated &&
                act.mutate(() =>
                  dated.kind === "publish"
                    ? publishJob(dated.job.id, endOfDayIso(date))
                    : extendJob(dated.job.id, endOfDayIso(date)),
                )
              }
            >
              {dated?.kind === "extend" ? t("jobs.extend") : t("jobs.publish")}
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <p className="text-sm leading-relaxed text-ink-muted">
            {dated?.kind === "extend" ? t("jobs.extend_explain") : t("jobs.publish_explain")}
          </p>
          <div>
            <Label htmlFor="job-closes">{t("jobs.closes_at")}</Label>
            <Input
              id="job-closes"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
        </div>
      </Dialog>
    </div>
  );
}
