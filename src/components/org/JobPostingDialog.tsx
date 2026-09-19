import { useMutation } from "@tanstack/react-query";
import { type JSX, useEffect, useState } from "react";
import { errorMessage } from "../../lib/errorMessage";
import { useI18n } from "../../lib/i18n";
import {
  editJob,
  type JobEmploymentType,
  type JobPostingAdmin,
  type JobPostingDraft,
  postJob,
} from "../../services/jobs";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Input, Label, Textarea } from "../ui/Input";
import { Select } from "../ui/Select";

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  // Null means "new posting". A live posting is never passed here -- the list
  // hides the edit button once the terms are frozen.
  editing: JobPostingAdmin | null;
}

const EMPTY: JobPostingDraft = {
  title: "",
  titleEn: "",
  summary: "",
  description: "",
  location: "",
  interviewLocation: "",
  employmentType: "full_time",
  openings: 1,
  minScore: 60,
  autoAdvanceScore: 85,
  inviteCap: 10,
};

const TYPES: JobEmploymentType[] = ["full_time", "part_time", "seasonal", "contract"];

export function JobPostingDialog(props: Props): JSX.Element | null {
  const { open, onClose, onSaved, editing } = props;
  const { t } = useI18n();
  const [draft, setDraft] = useState<JobPostingDraft>(EMPTY);
  const [error, setError] = useState<string | null>(null);

  // The dialog never unmounts, so a draft would otherwise survive Cancel and
  // reappear -- or worse, a previous posting's text would open under a new one.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setDraft(
      editing
        ? {
            title: editing.title,
            titleEn: editing.title_en ?? "",
            summary: editing.summary ?? "",
            description: editing.description,
            location: editing.location,
            interviewLocation: editing.interview_location,
            employmentType: editing.employment_type,
            openings: editing.openings,
            minScore: editing.min_score,
            autoAdvanceScore: editing.auto_advance_score,
            inviteCap: editing.invite_cap,
          }
        : EMPTY,
    );
  }, [open, editing]);

  const save = useMutation({
    mutationFn: () => (editing ? editJob(editing.id, draft) : postJob(draft).then(() => {})),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (e) => setError(errorMessage(e, t("jobs.save_failed"))),
  });

  const set = <K extends keyof JobPostingDraft>(key: K, value: JobPostingDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const ready =
    draft.title.trim() !== "" &&
    draft.description.trim() !== "" &&
    draft.location.trim() !== "" &&
    draft.interviewLocation.trim() !== "" &&
    draft.minScore <= draft.autoAdvanceScore;

  if (!open) return null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? t("jobs.edit_title") : t("jobs.new_title")}
      footer={
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!ready || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? t("common.loading") : t("jobs.save_draft")}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {error && <Alert variant="error">{error}</Alert>}

        <div>
          <Label htmlFor="job-title">{t("jobs.job_title")}</Label>
          <Input
            id="job-title"
            value={draft.title}
            onChange={(e) => set("title", e.target.value)}
            placeholder={t("jobs.job_title_placeholder")}
          />
        </div>

        <div>
          <Label htmlFor="job-title-en">{t("jobs.job_title_en")}</Label>
          <Input
            id="job-title-en"
            value={draft.titleEn}
            onChange={(e) => set("titleEn", e.target.value)}
          />
        </div>

        <div>
          <Label htmlFor="job-summary">{t("jobs.summary")}</Label>
          <Input
            id="job-summary"
            value={draft.summary}
            onChange={(e) => set("summary", e.target.value)}
            placeholder={t("jobs.summary_placeholder")}
          />
        </div>

        <div>
          <Label htmlFor="job-description">{t("jobs.description")}</Label>
          <Textarea
            id="job-description"
            rows={8}
            value={draft.description}
            onChange={(e) => set("description", e.target.value)}
            placeholder={t("jobs.description_placeholder")}
          />
          <p className="mt-1 text-xs leading-relaxed text-ink-faint">
            {t("jobs.description_hint")}
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="job-location">{t("jobs.location")}</Label>
            <Input
              id="job-location"
              value={draft.location}
              onChange={(e) => set("location", e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="job-interview">{t("jobs.interview_location")}</Label>
            <Input
              id="job-interview"
              value={draft.interviewLocation}
              onChange={(e) => set("interviewLocation", e.target.value)}
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="job-type">{t("jobs.employment_type")}</Label>
            <Select
              id="job-type"
              value={draft.employmentType}
              onChange={(v) => set("employmentType", v as JobEmploymentType)}
              ariaLabel={t("jobs.employment_type")}
              options={TYPES.map((k) => ({
                value: k,
                label: t(`public.type_${k}`),
              }))}
            />
          </div>
          <div>
            <Label htmlFor="job-openings">{t("jobs.openings")}</Label>
            <Input
              id="job-openings"
              type="number"
              min="1"
              value={String(draft.openings)}
              onChange={(e) => set("openings", Number(e.target.value) || 1)}
            />
          </div>
        </div>

        <fieldset className="rounded-lg border border-hairline p-4">
          <legend className="px-1 text-sm font-medium text-ink">{t("jobs.the_bar")}</legend>
          <p className="text-xs leading-relaxed text-ink-muted">{t("jobs.the_bar_hint")}</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="job-auto">{t("jobs.auto_advance")}</Label>
              <Input
                id="job-auto"
                type="number"
                min="0"
                max="100"
                value={String(draft.autoAdvanceScore)}
                onChange={(e) => set("autoAdvanceScore", Number(e.target.value) || 0)}
              />
            </div>
            <div>
              <Label htmlFor="job-min">{t("jobs.min_score")}</Label>
              <Input
                id="job-min"
                type="number"
                min="0"
                max="100"
                value={String(draft.minScore)}
                onChange={(e) => set("minScore", Number(e.target.value) || 0)}
              />
            </div>
            <div>
              <Label htmlFor="job-cap">{t("jobs.invite_cap")}</Label>
              <Input
                id="job-cap"
                type="number"
                min="1"
                value={String(draft.inviteCap)}
                onChange={(e) => set("inviteCap", Number(e.target.value) || 1)}
              />
            </div>
          </div>
          {draft.minScore > draft.autoAdvanceScore && (
            <p className="mt-2 text-xs text-danger-text">{t("jobs.bar_order")}</p>
          )}
        </fieldset>
      </div>
    </Dialog>
  );
}
