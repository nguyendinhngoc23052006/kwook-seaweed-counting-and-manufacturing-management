import { supabase } from "../lib/supabaseClient";

// Hiding, not destroying. One call for every managed thing, because the
// database keeps the interesting part -- who may hide what -- in one place too
// (org_archive, 20261009000000). Each entity's gate is the gate it already uses
// for being changed at all; bringing something back is the sysadmin's or the
// CEO's, whatever it is.
//
// Records are absent on purpose: an audit row, an attendance event, a count, a
// submitted application. Those are what happened, and what happened does not
// get hidden.
export type ArchivableEntity =
  | "org_node"
  | "person"
  | "position"
  | "rank"
  | "camera_device"
  | "camera_station"
  | "camera_line"
  | "job_posting"
  | "task";

export async function archiveEntity(entity: ArchivableEntity, id: string): Promise<void> {
  if (!id) throw new Error("nothing to hide");
  // Cameras keep their own pair, because archiving one also takes it off the
  // floor -- a camera nobody can see must not still be writing rows.
  if (entity === "camera_device") {
    const { error } = await supabase().rpc("org_camera_archive_device", { p_device_id: id });
    if (error) throw error;
    return;
  }
  const { error } = await supabase().rpc("org_archive", { p_entity: entity, p_id: id });
  if (error) throw error;
}

export async function unarchiveEntity(entity: ArchivableEntity, id: string): Promise<void> {
  if (!id) throw new Error("nothing to restore");
  if (entity === "camera_device") {
    const { error } = await supabase().rpc("org_camera_unarchive_device", { p_device_id: id });
    if (error) throw error;
    return;
  }
  const { error } = await supabase().rpc("org_unarchive", { p_entity: entity, p_id: id });
  if (error) throw error;
}
