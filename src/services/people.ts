import { supabase } from "../lib/supabaseClient";

// Local type definitions: this repo has no generated src/types/database.ts.
// Named to match the source repo exactly so other ported files resolve them.
export interface Person {
  id: string;
  employee_code: string;
  full_name: string;
  display_name: string | null;
  photo_url: string | null;
  email: string | null;
  phone: string | null;
  date_of_birth: string | null;
  national_id: string | null;
  address: string | null;
  hire_date: string | null;
  employment_note: string | null;
  status: "active" | "suspended" | "departed";
  account_id: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
}

export interface PersonBankDetails {
  person_id: string;
  bank_name: string | null;
  account_holder: string | null;
  account_number: string | null;
  branch: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
}

export interface AddFieldWorkerResult {
  person_id: string;
  employee_code: string;
  position_id: string;
}

export interface CreatePersonForSeatResult {
  person_id: string;
  employee_code: string;
}

// Editable profile fields. employee_code, id and account_id are missing on
// purpose: the first two are permanent and the third moves only through
// attachAccount(), and a trigger rejects any UPDATE that touches them.
export type PersonProfilePatch = Partial<
  Pick<
    Person,
    | "full_name"
    | "display_name"
    | "photo_url"
    | "email"
    | "phone"
    | "date_of_birth"
    | "national_id"
    | "address"
    | "hire_date"
    | "employment_note"
    | "status"
  >
>;

export type PersonBankPatch = Partial<
  Pick<PersonBankDetails, "bank_name" | "account_holder" | "account_number" | "branch">
>;

// The FIELD doorway: one call creates the human, their seat named after them,
// and the seating event. Persons carries no insert grant, so this RPC is the
// only way a person row comes into existence from the browser.
export async function addFieldWorker(input: {
  nodeId: string;
  fullName: string;
  rankKey: string;
  reportsToPositionId: string | null;
  phone?: string | null;
  email?: string | null;
  hireDate?: string | null;
}): Promise<AddFieldWorkerResult> {
  const fullName = input.fullName.trim();
  if (!fullName) throw new Error("full name required");
  if (!input.nodeId) throw new Error("node required");
  if (!input.rankKey) throw new Error("rank required");
  const { data, error } = await supabase().rpc("org_add_field_worker", {
    p_node_id: input.nodeId,
    p_full_name: fullName,
    p_rank_key: input.rankKey,
    p_reports_to_position_id: input.reportsToPositionId,
    p_phone: input.phone?.trim() || null,
    p_email: input.email?.trim() || null,
    p_hire_date: input.hireDate ?? null,
  });
  if (error) throw error;
  return data as AddFieldWorkerResult;
}

// The OFFICE doorway's second half: the seat already exists and stood empty.
// An office hire who already has a person record is seated with
// seatPerson() from src/services/positions.ts instead.
export async function createPersonForSeat(input: {
  positionId: string;
  fullName: string;
  phone?: string | null;
  email?: string | null;
  hireDate?: string | null;
}): Promise<CreatePersonForSeatResult> {
  const fullName = input.fullName.trim();
  if (!fullName) throw new Error("full name required");
  if (!input.positionId) throw new Error("position required");
  const { data, error } = await supabase().rpc("org_create_person_for_seat", {
    p_position_id: input.positionId,
    p_full_name: fullName,
    p_phone: input.phone?.trim() || null,
    p_email: input.email?.trim() || null,
    p_hire_date: input.hireDate ?? null,
  });
  if (error) throw error;
  return data as CreatePersonForSeatResult;
}

export async function getPerson(id: string): Promise<Person | null> {
  const { data, error } = await supabase().from("persons").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return (data as Person | null) ?? null;
}

// Who currently sits in this node, or in it and everything beneath it. The two
// definer functions do the tree walk and the as-of holder lookup server-side;
// RLS then narrows the person rows again, so a caller who can see the boxes but
// not the people gets an empty list rather than an error.
export async function listPeopleInNode(
  nodeId: string,
  { includeSubtree = true }: { includeSubtree?: boolean } = {},
): Promise<Person[]> {
  let nodeIds = [nodeId];
  if (includeSubtree) {
    const { data, error } = await supabase().rpc("org_subtree_ids", {
      p_nodes: [nodeId],
    });
    if (error) throw error;
    nodeIds = (data ?? []) as string[];
  }
  if (nodeIds.length === 0) return [];

  const { data: personIds, error: pErr } = await supabase().rpc("org_persons_seated_in", {
    p_nodes: nodeIds,
  });
  if (pErr) throw pErr;
  const ids = (personIds ?? []) as string[];
  if (ids.length === 0) return [];

  const { data: rows, error: rErr } = await supabase()
    .from("persons")
    .select("*")
    .in("id", ids)
    .order("full_name");
  if (rErr) throw rErr;
  return (rows ?? []) as Person[];
}

// Office staff maintain their own row; a manager maintains anyone in a subtree
// where they hold maintain_person_profile. Both land here — the policy decides
// which, and every write is audited.
export async function updatePersonProfile(id: string, patch: PersonProfilePatch): Promise<Person> {
  if (patch.full_name !== undefined && !patch.full_name.trim()) {
    throw new Error("full name required");
  }
  const { data, error } = await supabase()
    .from("persons")
    .update({
      ...patch,
      ...(patch.full_name !== undefined ? { full_name: patch.full_name.trim() } : {}),
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return data as Person;
}

// Bank details are a separate table behind a separate capability
// (maintain_bank_details), so a manager who can edit a profile does not
// thereby reach payroll. Returns null when the caller may not read them.
export async function getPersonBankDetails(personId: string): Promise<PersonBankDetails | null> {
  const { data, error } = await supabase()
    .from("person_bank_details")
    .select("*")
    .eq("person_id", personId)
    .maybeSingle();
  if (error) throw error;
  return (data as PersonBankDetails | null) ?? null;
}

// One row per person, so first write and correction are the same call. The
// owner accepted that a manager enters these with no employee confirmation
// step; the audit trigger records every version.
export async function savePersonBankDetails(
  personId: string,
  patch: PersonBankPatch,
): Promise<PersonBankDetails> {
  if (!personId) throw new Error("person required");
  const { data, error } = await supabase()
    .from("person_bank_details")
    .upsert({ person_id: personId, ...patch }, { onConflict: "person_id" })
    .select("*")
    .single();
  if (error) throw error;
  return data as PersonBankDetails;
}

// Attach (or, with null, detach) the optional login satellite. Only the
// sysadmin or the CEO may do this — anyone else pointing a person at their own
// account would inherit that person's seats — and the trigger enforces it, so
// this call simply surfaces the refusal.
export async function attachAccount(personId: string, accountId: string | null): Promise<Person> {
  const { data, error } = await supabase()
    .from("persons")
    .update({ account_id: accountId })
    .eq("id", personId)
    .select("*")
    .single();
  if (error) throw error;
  return data as Person;
}

// Offboarding, suspension, and coming back. Never a delete: employee codes
// must never be reused, so the row and every hour it ever worked stay. Since
// 20260928000000 this is what actually removes authority -- a non-active
// holder's seats confer nothing, the same way an archived unit's do -- and
// reactivating restores the lot.
export async function setPersonStatus(personId: string, status: Person["status"]): Promise<Person> {
  if (!personId) throw new Error("person required");
  const { data, error } = await supabase()
    .from("persons")
    .update({ status })
    .eq("id", personId)
    .select("*")
    .single();
  if (error) throw error;
  return data as Person;
}

// Everyone the caller may see: their own branch, any subtree where they
// maintain profiles, and themselves. RLS does the narrowing, so a caller with
// no seat gets an empty list rather than the company directory.
export async function listVisiblePersons(): Promise<Person[]> {
  const { data, error } = await supabase().from("persons").select("*").order("full_name");
  if (error) throw error;
  return (data ?? []) as Person[];
}

export type OptionalPersonWrite = "profile" | "bank";

// The optional halves of creating a person, applied AFTER the RPC that created
// them. They need capabilities the seat-creator may not hold, and the employee
// code is already burned, so a failure here must be reported as "this half is
// missing" rather than bubbling up as "the worker was not created". The caller
// never retries the creating RPC on the back of one.
export async function applyOptionalPersonDetails(
  personId: string,
  profile: PersonProfilePatch,
  bank: PersonBankPatch,
): Promise<OptionalPersonWrite[]> {
  const failed: OptionalPersonWrite[] = [];
  if (!personId) return failed;
  if (Object.keys(profile).length > 0) {
    try {
      await updatePersonProfile(personId, profile);
    } catch {
      failed.push("profile");
    }
  }
  if (Object.keys(bank).length > 0) {
    try {
      await savePersonBankDetails(personId, bank);
    } catch {
      failed.push("bank");
    }
  }
  return failed;
}
