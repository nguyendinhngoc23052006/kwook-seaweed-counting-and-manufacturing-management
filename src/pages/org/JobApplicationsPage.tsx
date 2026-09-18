import { useQuery } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApplicantCard } from "../../components/org/ApplicantCard";
import { Button } from "../../components/ui/Button";
import { Empty, ErrorState } from "../../components/ui/EmptyState";
import { ListSkeleton } from "../../components/ui/Skeleton";
import { errorMessage } from "../../lib/errorMessage";
import { useT } from "../../lib/i18n";
import { getMyCapabilityReach } from "../../services/capabilities";
import {
  APPLICATIONS_PAGE,
  type JobApplication,
  listApplications,
} from "../../services/jobApplications";

// Personal data belonging to people who do not work here. It is behind
// org_admin() in the database and behind the same check here, and it will be
// deleted when the posting has been closed long enough.
export function JobApplicationsPage(): JSX.Element {
  const { jobId } = useParams<{ jobId: string }>();
  const t = useT();
  // Keyset paging: each page asks for what is older than the last row we hold,
  // so an application arriving mid-read cannot duplicate or hide a row.
  const [pages, setPages] = useState<string[]>([]);

  const reach = useQuery({
    queryKey: ["org", "reach"],
    queryFn: getMyCapabilityReach,
  });
  const isAdmin = reach.data?.isAdmin === true;

  const before = pages[pages.length - 1];
  const applications = useQuery({
    queryKey: ["jobs", "applications", jobId ?? null, before ?? null],
    queryFn: () => listApplications(jobId ?? "", before),
    enabled: isAdmin && Boolean(jobId),
  });

  if (reach.isLoading || (isAdmin && applications.isLoading)) {
    return <ListSkeleton rows={4} label={t("applicants.loading")} />;
  }
  if (!isAdmin) {
    return <Empty title={t("jobs.not_yours")} description={t("jobs.not_yours_hint")} />;
  }
  if (applications.isError) {
    return (
      <ErrorState
        message={errorMessage(applications.error, t("applicants.load_failed"))}
        action={<Button onClick={() => applications.refetch()}>{t("common.retry")}</Button>}
      />
    );
  }

  const rows: JobApplication[] = applications.data ?? [];
  const more = rows.length === APPLICATIONS_PAGE;
  const lastCreatedAt = rows.at(-1)?.created_at;

  return (
    <div className="space-y-6">
      <div>
        <Link
          to="/org/jobs"
          className="inline-flex min-h-11 items-center text-sm text-accent-text hover:underline"
        >
          {t("applicants.back")}
        </Link>
        <h1 className="mt-2 font-display text-2xl font-bold text-ink">{t("applicants.title")}</h1>
        <p className="text-sm leading-relaxed text-ink-muted">
          {pages.length === 0
            ? t("applicants.subtitle", { n: rows.length })
            : t("applicants.page_n", { n: pages.length + 1 })}
        </p>
      </div>

      {rows.length === 0 ? (
        <Empty title={t("applicants.empty")} description={t("applicants.empty_hint")} />
      ) : (
        <div className="space-y-3">
          {rows.map((a) => (
            <ApplicantCard key={a.id} a={a} />
          ))}
        </div>
      )}

      {(more || pages.length > 0) && (
        <div className="flex flex-wrap gap-2">
          {pages.length > 0 && (
            <Button variant="secondary" onClick={() => setPages(pages.slice(0, -1))}>
              {t("applicants.previous")}
            </Button>
          )}
          {more && lastCreatedAt && (
            <Button variant="secondary" onClick={() => setPages([...pages, lastCreatedAt])}>
              {t("applicants.next")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
