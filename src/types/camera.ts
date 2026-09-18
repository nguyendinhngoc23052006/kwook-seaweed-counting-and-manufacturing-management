// Hand-written, not generated -- this repo has no `supabase generate types`
// pipeline wired to a linked project yet. Shapes match the migrations that
// define them (20260920000000_org_foundation.sql, 20260920010000_camera_devices.sql,
// 20260921000000_camera_export.sql); keep them in sync by hand until that changes.

export type CameraDeviceRole = "provisioning" | "counting" | "compliance" | "overview";

export interface CameraDevice {
  id: string;
  org_node_id: string;
  station_id: string | null;
  name: string;
  role: CameraDeviceRole;
  last_seen_at: string | null;
  app_version: string | null;
  algorithm_version: string | null;
  revoked_at: string | null;
  created_at: string;
  created_by: string | null;
}

export interface CameraStation {
  id: string;
  org_node_id: string;
  name: string;
  line: string;
  kind: CameraDeviceRole;
  active: boolean;
  created_at: string;
}

export interface CreatedCameraDevice {
  deviceId: string;
  email: string;
  password: string;
}

// The two camera capability keys left after 20260921000000_camera_export.sql
// retired export_camera_data: viewing a node's camera data implies exporting
// it, so there is no separate export key to hold.
export type CameraCapabilityKey = "manage_camera_devices" | "view_camera_data";

export interface CapabilityReach {
  personId: string | null;
  isAdmin: boolean;
  byKey: Record<string, string[]>;
}
