import { supabase } from "../lib/supabaseClient";

// Local type definitions: this repo has no generated src/types/database.ts.
// Named to match the source repo exactly so other ported files resolve them.
export type JobApplicationState =
  | "submitted"
  | "scoring"
  | "scored"
  | "invited"
  | "tested"
  | "interviewing"
  | "offered"
  | "hired"
  | "not_selected"
  | "withdrawn";

export interface JobApplicationDraft {
  fullName: string;
  email: string;
  phone: string;
  yearsExperience: number | null;
  currentJob: string;
  whyThisJob: string;
  cvText: string;
  portfolioUrl: string;
  // The honeypot. Always sent, always empty when a person filled the form.
  // Not named "website": browsers autofill that one.
  trap: string;
}

// The list row. It carries no long text on purpose: a popular role draws
// hundreds of applicants and cv_text runs to 20,000 characters, so the two long
// answers are fetched one applicant at a time, when someone is actually read.
export interface JobApplication {
  id: string;
  full_name: string;
  email: string;
  phone: string;
  years_experience: number | null;
  current_job: string | null;
  state: JobApplicationState;
  has_writing: boolean;
  score: number | null;
  created_at: string;
}

export interface JobApplicationDetail {
  id: string;
  why_this_job: string | null;
  cv_text: string | null;
  portfolio_url: string | null;
  cv_extracted_text: string | null;
  cv_flagged: boolean;
  cv_scan_note: string | null;
  score: number | null;
  score_reasoning: Array<{ criterion: string; note: string }> | null;
  scored_at: string | null;
  score_model: string | null;
}

// Applying is the only write an anonymous stranger can make, so every rule that
// matters -- the size caps, one per email, the rate limit, the honeypot -- lives
// in org_apply() rather than here. This function's job is to hand the form over
// and translate the refusal into something a person can act on.

export async function applyForJob(postingId: string, draft: JobApplicationDraft): Promise<string> {
  const { data, error } = await supabase().rpc("org_apply", {
    p_posting: postingId,
    p_full_name: draft.fullName,
    p_email: draft.email,
    p_phone: draft.phone,
    p_years_experience: draft.yearsExperience,
    p_current_job: draft.currentJob || null,
    p_why_this_job: draft.whyThisJob || null,
    p_cv_text: draft.cvText || null,
    p_portfolio_url: draft.portfolioUrl || null,
    p_trap: draft.trap || null,
  });
  if (error) throw error;
  if (!data) throw new Error("No application ID returned");
  return data as string;
}

// One page at a time, newest first. `before` is the created_at of the last row
// you have -- keyset rather than offset, so a new application arriving mid-read
// cannot make a row appear twice or vanish.
export const APPLICATIONS_PAGE = 50;

// The three states a posting is done with. org_applications() defaults to
// everything else (the live pipeline) when no states are passed.
const CLOSED_APPLICATION_STATES: JobApplicationState[] = ["hired", "not_selected", "withdrawn"];

export async function listApplications(
  postingId: string,
  before?: string,
): Promise<JobApplication[]> {
  const { data, error } = await supabase().rpc("org_applications", {
    p_posting: postingId,
    p_before: before ?? null,
    p_limit: APPLICATIONS_PAGE,
  });
  if (error) throw error;
  return Array.isArray(data) ? (data as JobApplication[]) : [];
}

// Same list, filtered to the terminal states -- the closed-applications
// disclosure's own page, kept paginated for the same reason the live list is.
export async function listClosedApplications(
  postingId: string,
  before?: string,
): Promise<JobApplication[]> {
  const { data, error } = await supabase().rpc("org_applications", {
    p_posting: postingId,
    p_before: before ?? null,
    p_limit: APPLICATIONS_PAGE,
    p_states: CLOSED_APPLICATION_STATES,
  });
  if (error) throw error;
  return Array.isArray(data) ? (data as JobApplication[]) : [];
}

// Cheap aggregate for the disclosure's label -- read before the disclosure is
// ever opened, so "Show 12 closed applications" is correct without fetching
// a page of them first.
export async function getClosedApplicationCount(postingId: string): Promise<number> {
  const { data, error } = await supabase().rpc("org_closed_application_count", {
    p_posting: postingId,
  });
  if (error) throw error;
  return typeof data === "number" ? data : 0;
}

// The two long answers, fetched only when someone opens an applicant.
export async function getApplicationDetail(id: string): Promise<JobApplicationDetail | null> {
  const { data, error } = await supabase().rpc("org_application_detail", {
    p_id: id,
  });
  if (error) throw error;
  return data ? (data as JobApplicationDetail) : null;
}

// One call for the whole desk rather than one per posting.
export async function getApplicationCounts(): Promise<Record<string, number>> {
  const { data, error } = await supabase().rpc("org_application_counts");
  if (error) throw error;
  return (data ?? {}) as Record<string, number>;
}

// Upload a CV file for an application. The file is stored in Supabase storage,
// and the application is marked as having a pending extraction.
export async function uploadCv(applicationId: string, file: File): Promise<void> {
  // Client-side size check — UX nicety only; real cap is server-side
  if (file.size > 5_242_880) {
    throw new Error("file too large");
  }

  // Determine extension from MIME type
  let ext = ".pdf";
  if (file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    ext = ".docx";
  } else if (file.type === "application/msword") {
    ext = ".docx";
  } else if (file.type === "image/jpeg") {
    ext = ".jpg";
  } else if (file.type === "image/png") {
    ext = ".png";
  }

  // Upload to storage
  const path = `${applicationId}/cv${ext}`;
  const { data, error: uploadError } = await supabase()
    .storage.from("cv-uploads")
    .upload(path, file, { contentType: file.type });

  if (uploadError) throw uploadError;
  if (!data) throw new Error("Upload returned no data");

  // Mark the application as having a CV uploaded
  const { error: markError } = await supabase().rpc("org_mark_cv_uploaded", {
    p_application_id: applicationId,
    p_file_path: data.path,
    p_mime: file.type,
    p_size: file.size,
  });

  if (markError) throw markError;
}

// The database speaks in SQLSTATEs; the form has to speak in sentences. Only
// these three are worth naming -- anything else is a real fault and belongs in
// the generic message, not in a guess.
export function applyErrorKey(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  if (code === "23505") return "apply.already_applied";
  if (code === "53400") return "apply.too_many";
  if (code === "22023") return "apply.closed";
  return "apply.failed";
}

// The funnel the app could see and never move. applications.state admits ten
// values and exactly two transitions were ever written -- the scoring function
// and org_book_interview_slot -- so nobody could invite, test, offer, hire or
// turn down a candidate from the running app.
//
// The shape lives in the database (org_application_next_states), not here: a
// copy in the client would be a second rulebook, and the RPC refuses anything
// the first one does not allow.
export async function advanceApplication(input: {
  applicationId: string;
  state: JobApplicationState;
  note?: string;
}): Promise<void> {
  if (!input.applicationId) throw new Error("application required");
  const { error } = await supabase().rpc("org_advance_application", {
    p_application: input.applicationId,
    p_state: input.state,
    p_note: input.note?.trim() || null,
  });
  if (error) throw error;
}

export async function applicationNextStates(
  state: JobApplicationState,
): Promise<JobApplicationState[]> {
  const { data, error } = await supabase().rpc("org_application_next_states", {
    p_state: state,
  });
  if (error) throw error;
  return (data ?? []) as JobApplicationState[];
}
