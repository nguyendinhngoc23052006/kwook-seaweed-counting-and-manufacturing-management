import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.0";

// Creating a device means creating a real Supabase Auth account -- something
// only the Admin API can do, never plain RLS. This function is therefore the
// one privileged path in the camera feature: it re-authenticates the CALLER
// with their own token before it ever switches to the service role.

interface CreateDeviceRequest {
  nodeId: string;
  name: string;
  role: "provisioning" | "counting" | "compliance" | "overview";
  stationId?: string | null;
}

const DEVICE_ROLES = ["provisioning", "counting", "compliance", "overview"];

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function generatePassword(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function notifyTelegram(deviceName: string, createdByName: string): Promise<void> {
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
  if (!botToken || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: `Camera device "${deviceName}" was created by ${createdByName}.`,
      }),
    });
  } catch (error) {
    console.error("Telegram notification failed (non-blocking):", error);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let body: CreateDeviceRequest;
  try {
    body = (await req.json()) as CreateDeviceRequest;
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }
  if (!body.nodeId || !body.name?.trim() || !DEVICE_ROLES.includes(body.role)) {
    return jsonResponse({ error: "nodeId, name, and a valid role are required" }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return jsonResponse({ error: "Supabase configuration missing" }, 500);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  // Step 1: verify the CALLER, under their own token -- never the service role.
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: callerAuth, error: callerAuthError } = await callerClient.auth.getUser();
  if (callerAuthError || !callerAuth.user) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  const callerId = callerAuth.user.id;

  const { data: canManage, error: canManageError } = await callerClient.rpc(
    "org_camera_can_manage",
    { p_node_id: body.nodeId },
  );
  if (canManageError) {
    console.error("capability check failed:", canManageError);
    return jsonResponse({ error: "could not verify permission" }, 500);
  }
  if (!canManage) {
    return jsonResponse({ error: "you cannot manage cameras at this node" }, 403);
  }

  // Best-effort: the caller's own name, for the Telegram notification only.
  let createdByName = "an admin";
  const { data: callerPerson } = await callerClient
    .from("persons")
    .select("full_name")
    .eq("account_id", callerId)
    .maybeSingle();
  if (callerPerson?.full_name) createdByName = callerPerson.full_name;

  // Step 2: create the device's own auth account (service role only from here on).
  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  const email = `device.${crypto.randomUUID()}@camera.kwook.internal`;
  const password = generatePassword();

  const { data: created, error: createError } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createError || !created.user) {
    console.error("device account creation failed:", createError);
    return jsonResponse({ error: "device account creation failed" }, 500);
  }

  // Step 3: write the device row back. If this fails, the auth account is
  // rolled back rather than left orphaned.
  const { error: writeError } = await adminClient.rpc("org_camera_create_device", {
    p_account_id: created.user.id,
    p_node_id: body.nodeId,
    p_name: body.name.trim(),
    p_role: body.role,
    p_created_by_account_id: callerId,
    p_station_id: body.stationId ?? null,
  });
  if (writeError) {
    console.error("device row write failed, rolling back auth account:", writeError);
    const { error: cleanupError } = await adminClient.auth.admin.deleteUser(created.user.id);
    if (cleanupError) {
      console.error(
        "rollback also failed -- orphaned auth account:",
        created.user.id,
        cleanupError,
      );
    }
    return jsonResponse({ error: "device registration failed" }, 500);
  }

  void notifyTelegram(body.name.trim(), createdByName);

  return jsonResponse({ deviceId: created.user.id, email, password }, 200);
});
