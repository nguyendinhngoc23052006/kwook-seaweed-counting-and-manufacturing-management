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
  getClosedApplicationCount,
  type JobApplication,
  listApplications,
  listClosedApplications,
} from "../../services/jobApplications";

type TFn = ReturnType<typeof useT>;

// Terminal-state applications (hired, not_selected, withdrawn), collapsed by
// default -- same interaction shape as CapabilityHistoryDisclosure
// (NodeCapabilityPanel.tsx): a toggle with the count in its own label, its own
// paged query that only runs once opened.
function ClosedApplicationsDisclosure({
  jobId,
  count,
  t,
}: {
  jobId: string;
  count: number;
  t: TFn;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [pages, setPages] = useState<string[]>([]);
  const before = pages[pages.length - 1];

  const closed = useQuery({
    queryKey: ["jobs", "closed-applications", jobId, before ?? null],
    queryFn: () => listClosedApplications(jobId, before),
    enabled: open,
  });

  if (count === 0) return null;

  const rows: JobApplication[] = closed.data ?? [];
  const more = rows.length === APPLICATIONS_PAGE;
  const lastCreatedAt = rows.at(-1)?.created_at;

  return (
    <div className="border-t border-hairline pt-4">
      <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? t("applicants.hide_closed") : t("applicants.show_closed", { count })}
      </Button>
      {open &&
        (closed.isLoading ? (
          <ListSkeleton rows={2} label={t("applicants.loading")} />
        ) : closed.isError ? (
          <ErrorState message={errorMessage(closed.error, t("applicants.load_failed"))} />
        ) : rows.length === 0 ? (
          <Empty title={t("applicants.empty")} />
        ) : (
          <div className="mt-3 space-y-3">
            {rows.map((a) => (
              <ApplicantCard key={a.id} a={a} />
            ))}
            {(more || pages.length > 0) && (
              <div className="flex flex-wrap gap-2">
                {pages.length > 0 && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setPages(pages.slice(0, -1))}
                  >
                    {t("applicants.previous")}
                  </Button>
                )}
                {more && lastCreatedAt && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setPages([...pages, lastCreatedAt])}
                  >
                    {t("applicants.next")}
                  </Button>
                )}
              </div>
            )}
          </div>
        ))}
    </div>
  );
}

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
  // Read alongside the live page, not inside the disclosure -- the label has
  // to say the right count before anyone has opened it.
  const closedCount = useQuery({
    queryKey: ["jobs", "closed-applications-count", jobId ?? null],
    queryFn: () => getClosedApplicationCount(jobId ?? ""),
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
          className="inline-flex min-h-11 items-center text-sm text-primary-text hover:underline"
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

      {jobId && <ClosedApplicationsDisclosure jobId={jobId} count={closedCount.data ?? 0} t={t} />}
    </div>
  );
}
