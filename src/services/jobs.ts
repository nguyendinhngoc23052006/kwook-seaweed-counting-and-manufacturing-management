import { supabase } from "../lib/supabaseClient";

// Local type definitions: this repo has no generated src/types/database.ts.
// Named to match the source repo exactly so other ported files resolve them.
export type JobEmploymentType = "full_time" | "part_time" | "seasonal" | "contract";

export type JobPostingState = "draft" | "open" | "closed" | "filled";

export interface JobBoardItem {
  id: string;
  title: string;
  title_en: string | null;
  summary: string | null;
  location: string;
  employment_type: JobEmploymentType;
  openings: number;
  closes_at: string | null;
  published_at: string | null;
}

export interface JobPostingPublic extends JobBoardItem {
  description: string;
  interview_location: string;
}

export interface JobPostingAdmin extends JobPostingPublic {
  min_score: number;
  auto_advance_score: number;
  invite_cap: number;
  state: JobPostingState;
  created_at: string;
}

export interface JobPostingDraft {
  title: string;
  titleEn: string;
  summary: string;
  description: string;
  location: string;
  interviewLocation: string;
  employmentType: JobEmploymentType;
  openings: number;
  minScore: number;
  autoAdvanceScore: number;
  inviteCap: number;
}

// The board and one posting are the only two things an anonymous visitor may
// call. Both are SECURITY DEFINER projections that omit every scoring
// threshold — an applicant who knows the bar writes to the bar.

export async function getJobBoard(): Promise<JobBoardItem[]> {
  const { data, error } = await supabase().rpc("org_job_board");
  if (error) throw error;
  return Array.isArray(data) ? (data as JobBoardItem[]) : [];
}

// Null means "not open", which is a real answer for a stale link rather than an
// error — and it deliberately does not distinguish a closed posting from an id
// that never existed.
export async function getJobPosting(id: string): Promise<JobPostingPublic | null> {
  const { data, error } = await supabase().rpc("org_job_posting", {
    p_id: id,
  });
  if (error) throw error;
  return data ? (data as JobPostingPublic) : null;
}

export async function listJobPostingsAdmin(): Promise<JobPostingAdmin[]> {
  const { data, error } = await supabase().rpc("org_job_postings_admin");
  if (error) throw error;
  return Array.isArray(data) ? (data as JobPostingAdmin[]) : [];
}

function args(draft: JobPostingDraft) {
  return {
    p_title: draft.title,
    p_description: draft.description,
    p_location: draft.location,
    p_interview_location: draft.interviewLocation,
    p_title_en: draft.titleEn || null,
    p_summary: draft.summary || null,
    p_employment_type: draft.employmentType,
    p_openings: draft.openings,
    p_min_score: draft.minScore,
    p_auto_advance_score: draft.autoAdvanceScore,
    p_invite_cap: draft.inviteCap,
  };
}

export async function postJob(draft: JobPostingDraft): Promise<string> {
  const { data, error } = await supabase().rpc("org_post_job", args(draft));
  if (error) throw error;
  return data as string;
}

export async function editJob(id: string, draft: JobPostingDraft): Promise<void> {
  const { error } = await supabase().rpc("org_edit_job", {
    p_id: id,
    ...args(draft),
  });
  if (error) throw error;
}

// Publishing freezes the terms, so it is its own verb rather than a field on
// the edit form.
export async function publishJob(id: string, closesAt: string): Promise<void> {
  const { error } = await supabase().rpc("org_publish_job", {
    p_id: id,
    p_closes_at: closesAt,
  });
  if (error) throw error;
}

export async function extendJob(id: string, closesAt: string): Promise<void> {
  const { error } = await supabase().rpc("org_extend_job", {
    p_id: id,
    p_closes_at: closesAt,
  });
  if (error) throw error;
}

export async function closeJob(id: string): Promise<void> {
  const { error } = await supabase().rpc("org_close_job", { p_id: id });
  if (error) throw error;
}

export async function discardDraftJob(id: string): Promise<void> {
  const { error } = await supabase().rpc("org_discard_draft_job", {
    p_id: id,
  });
  if (error) throw error;
}

export function daysLeft(closesAt: string | null, now = Date.now()): number | null {
  if (!closesAt) return null;
  return Math.ceil((Date.parse(closesAt) - now) / 86_400_000);
}
