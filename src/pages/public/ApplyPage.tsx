import { useMutation, useQuery } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";
import { Empty, ErrorState } from "../../components/ui/EmptyState";
import { Input, Label, Textarea } from "../../components/ui/Input";
import { ListSkeleton } from "../../components/ui/Skeleton";
import { errorMessage } from "../../lib/errorMessage";
import { useI18n } from "../../lib/i18n";
import {
  applyErrorKey,
  applyForJob,
  type JobApplicationDraft,
  uploadCv,
} from "../../services/jobApplications";
import { getJobPosting } from "../../services/jobs";

const EMPTY: JobApplicationDraft = {
  fullName: "",
  email: "",
  phone: "",
  yearsExperience: null,
  currentJob: "",
  whyThisJob: "",
  cvText: "",
  portfolioUrl: "",
  trap: "",
};

// The form a stranger fills in. Structured rather than "attach your CV": most of
// the people this factory hires do not have one, and the same fields from
// everybody are what make the scoring comparable.
export function ApplyPage(): JSX.Element {
  const { jobId } = useParams<{ jobId: string }>();
  const { t, locale } = useI18n();
  const [draft, setDraft] = useState<JobApplicationDraft>(EMPTY);
  const [cvFile, setCvFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const posting = useQuery({
    queryKey: ["jobs", "posting", jobId ?? null],
    queryFn: () => getJobPosting(jobId ?? ""),
    enabled: Boolean(jobId),
  });

  const send = useMutation({
    mutationFn: async () => {
      const applicationId = await applyForJob(jobId ?? "", draft);
      if (cvFile) {
        try {
          await uploadCv(applicationId, cvFile);
        } catch (e) {
          // Application succeeded; upload failed. Record the error but don't fail the submission.
          setUploadError(errorMessage(e, "Could not upload file"));
        }
      }
      return applicationId;
    },
    onSuccess: () => {
      setDraft(EMPTY);
      setCvFile(null);
      setError(null);
      setDone(true);
    },
    onError: (e) => setError(t(applyErrorKey(e))),
  });

  const set = <K extends keyof JobApplicationDraft>(key: K, value: JobApplicationDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  if (posting.isLoading) {
    return <ListSkeleton rows={4} label={t("public.loading_role")} />;
  }
  if (posting.isError) {
    return (
      <ErrorState
        message={t("public.role_failed")}
        action={<Button onClick={() => posting.refetch()}>{t("common.retry")}</Button>}
      />
    );
  }
  const job = posting.data;
  if (!job) {
    return <Empty title={t("public.role_closed")} description={t("public.role_closed_hint")} />;
  }

  const title = locale === "en" && job.title_en ? job.title_en : job.title;

  if (done) {
    return (
      <div className="max-w-xl space-y-4">
        <h1 className="font-display text-2xl font-bold text-ink">{t("apply.received")}</h1>
        <p className="text-base leading-relaxed text-ink-muted">
          {t("apply.received_body", { title })}
        </p>
        {uploadError && (
          <Alert variant="warning">
            {t("apply.file_upload_failed")} {uploadError}. {t("apply.file_upload_fallback")}
          </Alert>
        )}
        <Link
          to="/"
          className="inline-flex min-h-11 items-center text-sm text-accent-text hover:underline"
        >
          {t("public.back_to_roles")}
        </Link>
      </div>
    );
  }

  const ready =
    draft.fullName.trim() !== "" && draft.email.trim() !== "" && draft.phone.trim() !== "";

  return (
    <div className="max-w-xl space-y-6">
      <div>
        <Link
          to={`/jobs/${job.id}`}
          className="inline-flex min-h-11 items-center text-sm text-accent-text hover:underline"
        >
          {t("apply.back_to_role")}
        </Link>
        <h1 className="mt-2 font-display text-2xl font-bold leading-tight text-ink">
          {t("apply.title", { title })}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-muted">{t("apply.intro")}</p>
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !send.isPending) send.mutate();
        }}
      >
        <div>
          <Label htmlFor="apply-name">{t("apply.full_name")}</Label>
          <Input
            id="apply-name"
            value={draft.fullName}
            onChange={(e) => set("fullName", e.target.value)}
            maxLength={120}
            autoComplete="name"
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="apply-phone">{t("apply.phone")}</Label>
            <Input
              id="apply-phone"
              type="tel"
              value={draft.phone}
              onChange={(e) => set("phone", e.target.value)}
              maxLength={30}
              autoComplete="tel"
            />
          </div>
          <div>
            <Label htmlFor="apply-email">{t("apply.email")}</Label>
            <Input
              id="apply-email"
              type="email"
              value={draft.email}
              onChange={(e) => set("email", e.target.value)}
              maxLength={200}
              autoComplete="email"
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="apply-years">{t("apply.years")}</Label>
            <Input
              id="apply-years"
              type="number"
              min="0"
              max="60"
              value={draft.yearsExperience === null ? "" : String(draft.yearsExperience)}
              onChange={(e) =>
                set("yearsExperience", e.target.value === "" ? null : Number(e.target.value))
              }
            />
          </div>
          <div>
            <Label htmlFor="apply-current">{t("apply.current_job")}</Label>
            <Input
              id="apply-current"
              value={draft.currentJob}
              onChange={(e) => set("currentJob", e.target.value)}
              maxLength={200}
            />
          </div>
        </div>

        <div>
          <Label htmlFor="apply-portfolio">{t("apply.portfolio")}</Label>
          <Input
            id="apply-portfolio"
            // Not type="url": the server accepts a bare domain and prefixes
            // https:// itself, but the browser's native url validation demands
            // a full scheme up front and would silently block submission.
            type="text"
            value={draft.portfolioUrl}
            onChange={(e) => set("portfolioUrl", e.target.value)}
            maxLength={500}
            placeholder={t("apply.portfolio_placeholder")}
          />
        </div>

        <div>
          <Label htmlFor="apply-why">{t("apply.why")}</Label>
          <Textarea
            id="apply-why"
            rows={4}
            value={draft.whyThisJob}
            onChange={(e) => set("whyThisJob", e.target.value)}
            maxLength={2000}
            placeholder={t("apply.why_placeholder")}
          />
        </div>

        <div>
          <Label htmlFor="apply-cv">{t("apply.experience")}</Label>
          <Textarea
            id="apply-cv"
            rows={8}
            value={draft.cvText}
            onChange={(e) => set("cvText", e.target.value)}
            maxLength={20000}
            placeholder={t("apply.experience_placeholder")}
          />
          <p className="mt-1 text-xs leading-relaxed text-ink-faint">
            {t("apply.experience_hint")}
          </p>
        </div>

        <div>
          <Label htmlFor="apply-cv-file">{t("apply.cv_file")}</Label>
          <Input
            id="apply-cv-file"
            type="file"
            accept=".pdf,.docx,image/jpeg,image/png"
            onChange={(e) => setCvFile(e.target.files?.[0] ?? null)}
          />
          <p className="mt-1 text-xs leading-relaxed text-ink-faint">{t("apply.cv_file_hint")}</p>
        </div>

        {/* The honeypot. Off-screen rather than display:none, which some bots
            check for, and out of the tab order so a person never lands on it.
            The name is deliberately meaningless: a field called "website" or
            "url" gets autofilled from the browser's saved profile, and an
            autofilled honeypot would throw away a real application while
            showing its author a success page. */}
        <div
          aria-hidden="true"
          className="absolute left-[-9999px] top-auto h-px w-px overflow-hidden"
        >
          <input
            id="apply-ref-token"
            type="text"
            tabIndex={-1}
            autoComplete="off"
            value={draft.trap}
            onChange={(e) => set("trap", e.target.value)}
          />
        </div>

        <p className="text-xs leading-relaxed text-ink-faint">{t("apply.privacy")}</p>

        <Button type="submit" disabled={!ready || send.isPending}>
          {send.isPending ? t("apply.sending") : t("apply.submit")}
        </Button>
      </form>
    </div>
  );
}
