import { supabase } from "../lib/supabaseClient";

// Local type definitions: this repo has no generated src/types/database.ts.
// Named to match the source repo's export-name convention so sibling ported
// files that import by name still resolve.
//
// Mirrors supabase/migrations/20260923010000_interview_scheduling.sql: one
// shared pool of slots per posting, booked count derived live from
// applications.interview_slot_id rather than stored.

export interface InterviewSlotBooking {
  application_id: string;
  full_name: string;
}

// The admin management view (org_admin_interview_slots): every slot for a
// posting, booked or not, with who's booked into each.
export interface InterviewSlot {
  id: string;
  starts_at: string;
  ends_at: string;
  capacity: number;
  booked: InterviewSlotBooking[];
}

// The public view (org_interview_slots_for_application): only slots this
// application can still book, with remaining capacity instead of names — an
// anonymous candidate never sees who else is interviewing.
export interface OpenInterviewSlot {
  id: string;
  starts_at: string;
  ends_at: string;
  remaining: number;
}

export interface InterviewSlotDraft {
  startsAt: string;
  endsAt: string;
  capacity: number;
}

export interface BookedInterviewSlot {
  starts_at: string;
  ends_at: string;
}

// org_admin()-gated like every other job_postings write; org_add_interview_slots
// returns the new rows' ids.
export async function addInterviewSlots(
  postingId: string,
  slots: InterviewSlotDraft[],
): Promise<string[]> {
  const { data, error } = await supabase().rpc("org_add_interview_slots", {
    p_posting: postingId,
    p_slots: slots.map((slot) => ({
      starts_at: slot.startsAt,
      ends_at: slot.endsAt,
      capacity: slot.capacity,
    })),
  });
  if (error) throw error;
  return Array.isArray(data) ? (data as string[]) : [];
}

export async function adminInterviewSlots(postingId: string): Promise<InterviewSlot[]> {
  const { data, error } = await supabase().rpc("org_admin_interview_slots", {
    p_posting: postingId,
  });
  if (error) throw error;
  return Array.isArray(data) ? (data as InterviewSlot[]) : [];
}

// Anonymous, callable from the public careers site: the application id
// already in the candidate's browser (returned by applyForJob()) is the
// capability token, same posture as the CV-upload gate.
export async function interviewSlotsForApplication(
  applicationId: string,
): Promise<OpenInterviewSlot[]> {
  const { data, error } = await supabase().rpc("org_interview_slots_for_application", {
    p_application: applicationId,
  });
  if (error) throw error;
  return Array.isArray(data) ? (data as OpenInterviewSlot[]) : [];
}

// Anonymous, callable from the public careers site: rate-limited server-side
// by the same caller-fingerprint bucket org_apply() uses.
export async function bookInterviewSlot(
  applicationId: string,
  slotId: string,
): Promise<BookedInterviewSlot> {
  const { data, error } = await supabase().rpc("org_book_interview_slot", {
    p_application: applicationId,
    p_slot: slotId,
  });
  if (error) throw error;
  return data as BookedInterviewSlot;
}

// The rest of a slot's life. org_add_interview_slots created them and
// org_book_interview_slot filled one, and nothing else existed: a slot typed
// with the wrong time stayed wrong, one no longer offered could not be
// withdrawn, and a candidate booked into the wrong slot could never be
// released. interview_slots has RLS on with no policies and no grant, so every
// one of these is a definer RPC, not a new write path.
export async function updateInterviewSlot(input: {
  slotId: string;
  startsAt?: string;
  endsAt?: string;
  capacity?: number;
}): Promise<void> {
  if (!input.slotId) throw new Error("slot required");
  const { error } = await supabase().rpc("org_update_interview_slot", {
    p_slot: input.slotId,
    p_starts_at: input.startsAt ?? null,
    p_ends_at: input.endsAt ?? null,
    p_capacity: input.capacity ?? null,
  });
  if (error) throw error;
}

// Refused while anyone still stands in the slot: the FK is ON DELETE SET NULL,
// so deleting one out from under a booking would strip the time from a
// candidate who was told it and never told otherwise.
export async function removeInterviewSlot(slotId: string): Promise<void> {
  if (!slotId) throw new Error("slot required");
  const { error } = await supabase().rpc("org_remove_interview_slot", {
    p_slot: slotId,
  });
  if (error) throw error;
}

export async function releaseInterviewBooking(applicationId: string): Promise<void> {
  if (!applicationId) throw new Error("application required");
  const { error } = await supabase().rpc("org_release_interview_booking", {
    p_application: applicationId,
  });
  if (error) throw error;
}
