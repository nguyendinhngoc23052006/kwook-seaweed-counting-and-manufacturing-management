import { supabase } from "../lib/supabaseClient";

// The top privilege, and the door its own guard was written for.
//
// org_guard_sysadmins says "only a sitting sysadmin appoints another" -- a rule
// that could never fire, because org_sysadmins carries a SELECT policy and a
// SELECT grant and nothing else. The only sysadmin that ever existed was the
// one org_foundation seeded by matching an email, and that account could
// neither hand the keys over nor give them up. One lost login and the org
// model was permanently unadministrable.
export interface Sysadmin {
  account_id: string;
  email: string;
  since: string;
  note: string | null;
}

export async function listSysadmins(): Promise<Sysadmin[]> {
  const { data, error } = await supabase().rpc("org_sysadmin_list");
  if (error) throw error;
  return (data ?? []) as Sysadmin[];
}

// By email because that is what a human knows; auth.users is readable by no
// client, so the definer resolves it.
export async function appointSysadmin(email: string, note?: string): Promise<void> {
  const address = email.trim();
  if (!address) throw new Error("email required");
  const { error } = await supabase().rpc("org_appoint_sysadmin", {
    p_email: address,
    p_note: note?.trim() || null,
  });
  if (error) throw error;
}

// Refused when it would empty the room. A model with no active sysadmin cannot
// create the first seat or write the first grant, which is the exact condition
// org_foundation's self-check refuses to deploy into.
export async function retireSysadmin(accountId: string, note?: string): Promise<void> {
  if (!accountId) throw new Error("account required");
  const { error } = await supabase().rpc("org_retire_sysadmin", {
    p_account_id: accountId,
    p_note: note?.trim() || null,
  });
  if (error) throw error;
}
