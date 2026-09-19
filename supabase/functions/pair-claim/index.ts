// pair-claim: a signed-in admin claims the QR a camera is showing, and an ORG
// camera comes into existence at the node they claimed it into.
//
// Runs with the service role (platform-provided env), which is exactly why it
// exists: creating the device's auth account and minting its one-time login
// token are the only privileged steps in pairing. The caller's authority is
// verified server-side from their own JWT before the service role is touched -
// the browser can claim nothing on its own.
//
// This is the ONLY way a camera is created. The old alternative handed the
// admin an email and a password to type into the phone, which the constitution
// forbids outright ("Cameras never have credentials"); it is deleted.
//
// It also RE-pairs. A camera's identity is the camera_devices row and its auth
// account, both permanent; what is fragile is the login the phone keeps in its
// own storage, which browsers evict and people clear. Without a way back to the
// same row, a phone that lost its login had to be paired afresh -- minting a
// SECOND camera and orphaning the first, so one physical camera's history
// arrived split across two rows that nothing joins. Passing device_id re-points
// an existing camera at whatever phone is showing the QR: same row, same
// history, new handset.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// The catalog the database itself enforces (camera_devices_role_check). Listed
// here only to refuse a typo before spending an auth account on it -- the CHECK
// constraint and org_camera_create_device() are what actually decide.
const DEVICE_ROLES = [
  "provisioning",
  "counting",
  "compliance",
  "overview",
  "check_in",
  "check_out",
];

function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "POST only" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return reply(500, { error: "Supabase configuration missing" });
  }

  const service = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return reply(401, { error: "No Authorization token on the request" });

  const asCaller = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false },
  });

  const { data: userData, error: userError } = await asCaller.auth.getUser();
  if (userError || !userData.user) {
    return reply(401, { error: `Not signed in: ${userError?.message ?? "no user"}` });
  }
  const callerId = userData.user.id;

  const { code, name, role, node_id, station_id, device_id } = await req.json().catch(() => ({}));
  if (typeof code !== "string" || code.length < 32) return reply(400, { error: "Bad code" });

  const isRepair = typeof device_id === "string" && device_id.length > 0;

  // Which node is being claimed into. For a new camera the caller names it; for
  // a re-pair it is the node the camera ALREADY stands in, read from its own
  // row -- a caller cannot move a camera by re-pairing it somewhere else.
  let targetNode = node_id;
  if (isRepair) {
    const { data: existing, error: existingError } = await asCaller
      .from("camera_devices")
      .select("org_node_id, revoked_at")
      .eq("id", device_id)
      .maybeSingle();
    if (existingError) {
      return reply(500, { error: `Could not read that camera: ${existingError.message}` });
    }
    if (!existing) return reply(404, { error: "No such camera" });
    // Re-pairing a revoked camera would quietly put it back on the floor. Being
    // revoked is a decision; undoing it is its own decision, made in Cameras.
    if (existing.revoked_at) {
      return reply(409, { error: "That camera is revoked. Restore it first, then re-pair." });
    }
    targetNode = existing.org_node_id;
  } else {
    if (typeof name !== "string" || name.trim().length === 0) {
      return reply(400, { error: "Name required" });
    }
    if (typeof node_id !== "string" || node_id.length === 0) {
      return reply(400, { error: "Node required" });
    }
    if (typeof role !== "string" || !DEVICE_ROLES.includes(role)) {
      return reply(400, { error: "Unknown camera role" });
    }
  }

  // The gate, asked with the CALLER'S OWN token under RLS: may this person
  // manage cameras at that node? Never a header, never a body field, and never
  // the service role.
  const { data: canManage, error: canManageError } = await asCaller.rpc("org_camera_can_manage", {
    p_node_id: targetNode,
  });
  if (canManageError) {
    return reply(500, { error: `Could not verify permission: ${canManageError.message}` });
  }
  if (!canManage) return reply(403, { error: "You cannot manage cameras at this node" });

  // Bounded outstanding claims - belt and braces, since only people who can
  // manage cameras somewhere reach this line anyway.
  const { count } = await service
    .from("pairing_codes")
    .select("id", { count: "exact", head: true })
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString());
  if ((count ?? 0) >= 20) {
    return reply(429, { error: "Too many unclaimed pairings - wait for them to expire" });
  }

  // A re-pair reuses the camera's own account, so there is nothing to create
  // and nothing to roll back -- only a fresh one-time token for the new phone.
  let deviceId: string;
  let email: string;
  let rollback: (message: string, status?: number) => Promise<Response>;

  if (isRepair) {
    deviceId = device_id;
    const { data: account, error: accountError } = await service.auth.admin.getUserById(deviceId);
    if (accountError || !account.user?.email) {
      return reply(500, {
        error: `Could not read that camera's account: ${accountError?.message}`,
      });
    }
    email = account.user.email;
    rollback = (message, status = 500) => Promise.resolve(reply(status, { error: message }));
  } else {
    // The device account. Random address, random unknowable password - nobody
    // ever types credentials on a camera, and nobody is ever shown them.
    email = `${crypto.randomUUID()}@machines.kwook.internal`;
    const { data: created, error: createError } = await service.auth.admin.createUser({
      email,
      email_confirm: true,
      password: crypto.randomUUID() + crypto.randomUUID(),
      user_metadata: { display_name: name.trim() },
    });
    if (createError || !created.user) {
      return reply(500, { error: `Create failed: ${createError?.message}` });
    }
    deviceId = created.user.id;

    // Everything past this point can fail, and an auth account with no camera
    // row is an orphan nobody can see or delete from the app. So each failure
    // rolls the account back before it answers.
    rollback = async (message, status = 500) => {
      const { error: cleanupError } = await service.auth.admin.deleteUser(deviceId);
      if (cleanupError) {
        console.error("rollback failed -- orphaned auth account:", deviceId, cleanupError);
      }
      return reply(status, { error: message });
    };

    // One writer for the camera row: the same security-definer function the org
    // hub has always used. It flips the profile to kind='device' (the
    // on_auth_user_created trigger makes every new account a pending HUMAN,
    // which would strand the camera on the approval screen) and re-checks the
    // role against the catalog.
    const { error: deviceError } = await service.rpc("org_camera_create_device", {
      p_account_id: deviceId,
      p_node_id: node_id,
      p_name: name.trim(),
      p_role: role,
      p_created_by_account_id: callerId,
      p_station_id: station_id || null,
    });
    if (deviceError) return await rollback(`Device: ${deviceError.message}`);
  }

  // One-time login token for the waiting camera.
  const { data: link, error: linkError } = await service.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  const tokenHash = link?.properties?.hashed_token;
  if (linkError || !tokenHash) return await rollback(`Link: ${linkError?.message}`);

  const { error: pairError } = await service.from("pairing_codes").insert({
    device_id: deviceId,
    code_hash: await sha256Hex(code),
    token_hash: tokenHash,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });
  if (pairError) return await rollback(`Pairing: ${pairError.message}`);

  return reply(200, { ok: true, device_id: deviceId, repaired: isRepair });
});
