import { useQuery } from "@tanstack/react-query";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import { Button } from "../../components/ui/Button";
import { Empty, ErrorState } from "../../components/ui/EmptyState";
import { Pill } from "../../components/ui/Pill";
import { ListSkeleton } from "../../components/ui/Skeleton";
import { errorMessage } from "../../lib/errorMessage";
import { useI18n } from "../../lib/i18n";
import { daysLeft, getJobPosting } from "../../services/jobs";

export function JobDetailPage(): JSX.Element {
  const { jobId } = useParams<{ jobId: string }>();
  const { t, locale } = useI18n();

  const posting = useQuery({
    queryKey: ["jobs", "posting", jobId ?? null],
    queryFn: () => getJobPosting(jobId ?? ""),
    enabled: Boolean(jobId),
  });

  if (posting.isLoading) {
    return <ListSkeleton rows={4} label={t("public.loading_role")} />;
  }
  if (posting.isError) {
    return (
      <ErrorState
        message={errorMessage(posting.error, t("public.role_failed"))}
        action={<Button onClick={() => posting.refetch()}>{t("common.retry")}</Button>}
      />
    );
  }

  const job = posting.data;
  // A closed posting and an id that never existed look identical on purpose --
  // a stale link should not confirm which roles the company once had open.
  if (!job) {
    return <Empty title={t("public.role_closed")} description={t("public.role_closed_hint")} />;
  }

  const left = daysLeft(job.closes_at);
  const title = locale === "en" && job.title_en ? job.title_en : job.title;

  return (
    <article className="max-w-3xl space-y-8">
      <div>
        <Link
          to="/"
          className="inline-flex min-h-11 items-center text-sm text-accent-text hover:underline"
        >
          {t("public.back_to_roles")}
        </Link>
        <h1 className="mt-2 font-display text-3xl font-bold leading-tight text-ink">{title}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Pill tone="accent">{job.location}</Pill>
          <Pill>{t(`public.type_${job.employment_type}`)}</Pill>
          {job.openings > 1 && <Pill>{t("public.openings_n", { n: job.openings })}</Pill>}
          {left !== null && (
            <Pill tone={left <= 2 ? "danger" : left <= 7 ? "warning" : "neutral"}>
              {left <= 0 ? t("public.closing_today") : t("public.closing_in", { days: left })}
            </Pill>
          )}
        </div>
      </div>

      {job.summary && <p className="text-base leading-relaxed text-ink">{job.summary}</p>}

      <section>
        <h2 className="font-display text-lg font-semibold text-ink">{t("public.the_role")}</h2>
        {/* The JD is authored as one document, so it is rendered as written --
            whitespace-pre-line, never dangerouslySetInnerHTML. */}
        <p className="mt-2 whitespace-pre-line text-base leading-relaxed text-ink-muted">
          {job.description}
        </p>
      </section>

      <section className="rounded-xl border border-hairline bg-surface-raised p-5">
        <h2 className="font-display text-lg font-semibold text-ink">{t("public.how_it_works")}</h2>
        <ol className="mt-3 space-y-2 text-sm leading-relaxed text-ink-muted">
          <li>{t("public.step_apply")}</li>
          <li>{t("public.step_test")}</li>
          <li>{t("public.step_meet", { place: job.interview_location })}</li>
        </ol>
        <Link
          to={`/jobs/${job.id}/apply`}
          className="mt-4 inline-flex min-h-12 items-center justify-center rounded-lg bg-accent px-4 text-base font-medium text-accent-on transition hover:bg-accent-strong"
        >
          {t("public.apply_now")}
        </Link>
      </section>
    </article>
  );
}
