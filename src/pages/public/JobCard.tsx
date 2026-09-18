import type { JSX } from "react";
import { Link } from "react-router-dom";
import { Pill } from "../../components/ui/Pill";
import { useI18n } from "../../lib/i18n";
import { daysLeft, type JobBoardItem } from "../../services/jobs";

interface Props {
  job: JobBoardItem;
}

// One open role. The whole card is the target -- an applicant on a phone in a
// factory car park should not have to find a small blue link.
export function JobCard({ job }: Props): JSX.Element {
  const { t, locale } = useI18n();
  const left = daysLeft(job.closes_at);
  const title = locale === "en" && job.title_en ? job.title_en : job.title;

  return (
    <article className="relative rounded-xl border border-hairline bg-surface-raised p-5 transition-colors hover:bg-surface-muted">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 className="min-w-0 flex-1 font-display text-lg font-semibold leading-snug text-ink">
          <Link
            to={`/jobs/${job.id}`}
            className="before:absolute before:inset-0 before:content-['']"
          >
            {title}
          </Link>
        </h3>
        {left !== null && left <= 7 && (
          <Pill tone={left <= 2 ? "danger" : "warning"}>
            {left <= 0 ? t("public.closing_today") : t("public.closing_in", { days: left })}
          </Pill>
        )}
      </div>

      {job.summary && <p className="mt-2 text-sm leading-relaxed text-ink-muted">{job.summary}</p>}

      <dl className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-muted">
        <div className="flex items-center gap-1.5">
          <dt className="sr-only">{t("public.location")}</dt>
          <dd className="font-medium text-ink">{job.location}</dd>
        </div>
        <div className="flex items-center gap-1.5">
          <dt className="sr-only">{t("public.employment_type")}</dt>
          <dd>{t(`public.type_${job.employment_type}`)}</dd>
        </div>
        {job.openings > 1 && (
          <div className="flex items-center gap-1.5">
            <dt className="sr-only">{t("public.openings")}</dt>
            <dd>{t("public.openings_n", { n: job.openings })}</dd>
          </div>
        )}
      </dl>
    </article>
  );
}
