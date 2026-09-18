import { useQuery } from "@tanstack/react-query";
import type { JSX } from "react";
import { Button } from "../../components/ui/Button";
import { Empty, ErrorState } from "../../components/ui/EmptyState";
import { ListSkeleton } from "../../components/ui/Skeleton";
import { errorMessage } from "../../lib/errorMessage";
import { useI18n } from "../../lib/i18n";
import { getJobBoard } from "../../services/jobs";
import { JobCard } from "./JobCard";

// The homepage IS the job board. A separate marketing page above a separate
// careers page would be two things to maintain and one more click for the only
// visitor this page has: someone deciding whether to apply.
export function HomePage(): JSX.Element {
  const { t } = useI18n();
  const board = useQuery({ queryKey: ["jobs", "board"], queryFn: getJobBoard });

  return (
    <div className="space-y-10">
      <section className="max-w-2xl">
        <p className="text-sm font-medium uppercase tracking-wide text-accent-text">
          {t("public.eyebrow")}
        </p>
        <h1 className="mt-2 font-display text-3xl font-bold leading-tight text-ink sm:text-4xl">
          {t("public.headline")}
        </h1>
        <p className="mt-4 text-base leading-relaxed text-ink-muted">{t("public.intro")}</p>
      </section>

      <section aria-labelledby="open-roles">
        <h2 id="open-roles" className="font-display text-xl font-semibold text-ink">
          {t("public.open_roles")}
        </h2>

        <div className="mt-4">
          {board.isLoading ? (
            <ListSkeleton rows={3} label={t("public.loading_roles")} />
          ) : board.isError ? (
            <ErrorState
              message={errorMessage(board.error, t("public.roles_failed"))}
              action={<Button onClick={() => board.refetch()}>{t("common.retry")}</Button>}
            />
          ) : (board.data ?? []).length === 0 ? (
            <Empty title={t("public.no_roles")} description={t("public.no_roles_hint")} />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {(board.data ?? []).map((job) => (
                <JobCard key={job.id} job={job} />
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
