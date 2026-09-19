// pair-claim: a signed-in ADMIN claims the QR a camera is showing.
//
// Runs with the service role (platform-provided env), which is exactly why it
// exists: creating the device account and minting its one-time login token are
// the only privileged steps in pairing. The caller's admin role is verified
// server-side from their JWT - the browser can claim nothing on its own.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

  const service = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  // Who is calling? Verify with the caller's OWN token: a user-scoped client
  // reads its own profile under RLS (profile_self), so the admin gate never
  // depends on the service-role key being present - only the privileged writes
  // below do. getUser errors surface verbatim so failures are diagnosable.
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return reply(401, { error: "No Authorization token on the request" });

  const asCaller = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    { global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false } },
  );

  const { data: userData, error: userError } = await asCaller.auth.getUser();
  if (userError || !userData.user) {
    return reply(401, { error: `Not signed in: ${userError?.message ?? "no user"}` });
  }

  const { data: caller, error: callerError } = await asCaller
    .from("profiles")
    .select("kind, role")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (callerError) return reply(500, { error: `Profile read failed: ${callerError.message}` });
  if (!caller) return reply(403, { error: "No profile for this account yet" });
  if (caller.kind !== "human" || caller.role !== "owner") {
    return reply(403, { error: `Owner only (your role: ${caller.role})` });
  }

  const { code, name, func, station_id } = await req.json().catch(() => ({}));
  if (typeof code !== "string" || code.length < 32) return reply(400, { error: "Bad code" });
  if (typeof name !== "string" || name.trim().length === 0) {
    return reply(400, { error: "Name required" });
  }
  // Server-side function catalog: only what has real vision behind it.
  if (func !== "counting") return reply(400, { error: "Unknown function" });

  // Bounded outstanding claims - belt and braces, since only
  // admins can reach this line anyway.
  const { count } = await service
    .from("pairing_codes")
    .select("id", { count: "exact", head: true })
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString());
  if ((count ?? 0) >= 20)
    return reply(429, { error: "Too many unclaimed pairings - wait for them to expire" });

  // The device account. Random address, random unknowable password - nobody
  // ever types credentials on a camera.
  const email = `${crypto.randomUUID()}@machines.kwook.internal`;
  const { data: created, error: createError } = await service.auth.admin.createUser({
    email,
    email_confirm: true,
    password: crypto.randomUUID() + crypto.randomUUID(),
    user_metadata: { display_name: name.trim() },
  });
  if (createError || !created.user)
    return reply(500, { error: `Create failed: ${createError?.message}` });
  const deviceId = created.user.id;

  // The on_auth_user_created trigger made a pending human profile; make it the device.
  const { error: profileError } = await service
    .from("profiles")
    .update({ kind: "device", role: "viewer" })
    .eq("id", deviceId);
  if (profileError) return reply(500, { error: `Profile: ${profileError.message}` });

  const { error: deviceError } = await service.from("devices").insert({
    id: deviceId,
    name: name.trim(),
    camera_function: func,
    station_id: station_id || null,
  });
  if (deviceError) return reply(500, { error: `Device: ${deviceError.message}` });

  // One-time login token for the waiting camera.
  const { data: link, error: linkError } = await service.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  const tokenHash = link?.properties?.hashed_token;
  if (linkError || !tokenHash) return reply(500, { error: `Link: ${linkError?.message}` });

  const { error: pairError } = await service.from("pairing_codes").insert({
    device_id: deviceId,
    code_hash: await sha256Hex(code),
    token_hash: tokenHash,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });
  if (pairError) return reply(500, { error: `Pairing: ${pairError.message}` });

  return reply(200, { ok: true, device_id: deviceId });
});
