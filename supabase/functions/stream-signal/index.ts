// stream-signal: the only door between a browser and the Cloudflare Realtime SFU.
//
// WHAT THE OWNER CLICKS - dashboards only, no terminal:
//
//   1. Cloudflare dashboard -> create a Realtime App. "When you create a
//      Realtime App, you will get: App ID, App Secret. These two combined will
//      allow you to make API Realtime from your backend server to Realtime."
//      Make one app per environment - one for staging, one for production -
//      since "Every Realtime App is a separate environment".
//      (developers.cloudflare.com/realtime/sfu/get-started/, Verified 2026-09-17)
//
//   2. Supabase dashboard -> Edge Functions -> Secrets, on the staging project
//      AND on the production project separately, add:
//         REALTIME_SFU_APP_ID      = the App ID
//         REALTIME_SFU_APP_SECRET  = the App Secret
//
//   3. Nothing else. Until both secrets exist this function answers
//      { configured: false }, the phones never open a stream, and counting
//      behaves exactly as it does today.
//
// WHY THIS IS A PROXY AND NOT A TOKEN ENDPOINT
//
// There is no browser-facing SFU credential to mint. The App Secret is a bearer
// token for the entire app: "Your backend stores the application secret and
// uses the Realtime SFU API to create the corresponding session" and "It is
// vital to manage App ID and its secret securely. While track and session IDs
// can be public, they should be protected to prevent misuse. An attacker could
// exploit these IDs to disrupt service if your backend server does not
// authenticate request origins properly, for example by sending requests to
// close tracks on sessions other than their own."
// (developers.cloudflare.com/realtime/sfu/ and .../sfu/https-api/, Verified
// 2026-09-17.)
//
// So this function holds the secret, calls the SFU server-side, and returns an
// SDP answer and one identifier of our own. Nothing about the Realtime app
// reaches the client bundle - not the secret, not the App ID, and not the SFU
// session or track ids, which is also why the browser cannot ask to close
// anyone's tracks: it has no name for them.
//
// WHAT IS NOT HERE YET: the pull half. A wall tile subscribes by naming the
// publisher's SFU session id and track name, and nothing in the schema records
// them - stream_sessions has no column to hold them, and the SFU offers no way
// to look a session up by anything but its own id. Adding
// stream_sessions.sfu_session_id (the track name is already the capture session
// id) in a migration is what unblocks a "watch" action here, gated on a
// signed-in human at viewer+. Until then cameras publish and nobody watches.
//
// Cost of publishing before any wall tile can pull: none. "Only traffic
// originating from Cloudflare towards clients incurs charges. Traffic pushed to
// Cloudflare incurs no charge even if there is no client pulling same traffic
// from Cloudflare." (developers.cloudflare.com/realtime/sfu/pricing/, Verified
// 2026-09-17.)
import { createClient } from "npm:@supabase/supabase-js@2";

const SFU_BASE_URL = "https://rtc.live.cloudflare.com/v1";

// A one-video-track offer. Anything near this length is not one.
const MAX_SDP_LENGTH = 20_000;

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "POST only" });

  // The caller is verified FIRST, with their own token, under RLS - exactly as
  // pair-claim does it. Nothing below trusts a field in the body to say who
  // sent it.
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
  const callerId = userData.user.id;

  const { data: caller, error: callerError } = await asCaller
    .from("profiles")
    .select("tenant_id, kind")
    .eq("id", callerId)
    .maybeSingle();
  if (callerError) return reply(500, { error: `Profile read failed: ${callerError.message}` });
  if (!caller) return reply(403, { error: "No profile for this account yet" });
  // Publishing is a camera's act. A human is a viewer of the wall, never a
  // source on it.
  if (caller.kind !== "device") return reply(403, { error: "Cameras publish, people watch" });

  // Unpairing is a row, not a phone: a revoked device keeps its token until it
  // expires, so every privileged path re-reads revoked_at.
  const { data: device, error: deviceError } = await asCaller
    .from("devices")
    .select("id, revoked_at")
    .eq("id", callerId)
    .maybeSingle();
  if (deviceError) return reply(500, { error: `Device read failed: ${deviceError.message}` });
  if (!device || device.revoked_at !== null)
    return reply(403, { error: "This camera is unpaired" });

  const body = await req.json().catch(() => ({}));
  const { action } = body;

  const service = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  if (action === "stop") {
    const { streamSessionId } = body;
    if (typeof streamSessionId !== "string") return reply(400, { error: "Bad streamSessionId" });
    // Scoped to this device's own open rows, so a camera can only ever close
    // its own stream and can never relabel one that is already closed.
    const { error } = await service
      .from("stream_sessions")
      .update({ ended_at: new Date().toISOString(), end_reason: "stopped" })
      .eq("id", streamSessionId)
      .eq("device_id", callerId)
      .is("ended_at", null);
    if (error) return reply(500, { error: `Stream session: ${error.message}` });
    return reply(200, { ok: true });
  }

  if (action !== "publish") return reply(400, { error: "Unknown action" });

  const { captureSessionId, sdp } = body;
  if (typeof captureSessionId !== "string") return reply(400, { error: "Bad captureSessionId" });
  if (typeof sdp !== "string" || sdp.length === 0 || sdp.length > MAX_SDP_LENGTH) {
    return reply(400, { error: "Bad offer" });
  }
  // Rule 6, enforced where it cannot be argued with. A browser that offered
  // audio is refused outright rather than published with the audio stripped.
  if (/^m=audio/im.test(sdp)) return reply(400, { error: "No audio, ever" });

  // Streaming is per capture session: the run has to be this camera's own, and
  // it has to still be open. A phone with no recording run has nothing to show.
  const { data: captureSession, error: captureError } = await asCaller
    .from("capture_sessions")
    .select("id")
    .eq("id", captureSessionId)
    .eq("device_id", callerId)
    .is("ended_at", null)
    .maybeSingle();
  if (captureError) return reply(500, { error: `Session read failed: ${captureError.message}` });
  if (!captureSession) return reply(403, { error: "No open recording run for this camera" });

  const appId = Deno.env.get("REALTIME_SFU_APP_ID") ?? "";
  const appSecret = Deno.env.get("REALTIME_SFU_APP_SECRET") ?? "";
  if (!appId || !appSecret) return reply(200, { configured: false });

  const sfuHeaders = {
    Authorization: `Bearer ${appSecret}`,
    "Content-Type": "application/json",
  };

  const newSession = await fetch(`${SFU_BASE_URL}/apps/${appId}/sessions/new`, {
    method: "POST",
    headers: sfuHeaders,
  });
  const session = await newSession.json().catch(() => ({}));
  // The SFU's own error text can name the app; it is logged, never returned.
  if (!newSession.ok || typeof session.sessionId !== "string") {
    console.error("SFU sessions/new failed", newSession.status, session.errorDescription);
    return reply(502, { error: "Live view is unavailable" });
  }

  const newTracks = await fetch(
    `${SFU_BASE_URL}/apps/${appId}/sessions/${session.sessionId}/tracks/new`,
    {
      method: "POST",
      headers: sfuHeaders,
      body: JSON.stringify({
        sessionDescription: { type: "offer", sdp },
        // The capture session names the track, so a future wall tile asks for a
        // recording run rather than for a phone.
        tracks: [{ location: "local", mid: firstMid(sdp), trackName: captureSessionId }],
      }),
    },
  );
  const tracks = await newTracks.json().catch(() => ({}));
  const answerSdp = tracks?.sessionDescription?.sdp;
  if (!newTracks.ok || tracks.errorCode || typeof answerSdp !== "string") {
    console.error("SFU tracks/new failed", newTracks.status, tracks.errorDescription);
    return reply(502, { error: "Live view is unavailable" });
  }

  // Who streamed, and when. No media touches Supabase.
  const { data: streamSession, error: streamError } = await service
    .from("stream_sessions")
    .insert({ tenant_id: caller.tenant_id, device_id: callerId })
    .select("id")
    .single();
  if (streamError) return reply(500, { error: `Stream session: ${streamError.message}` });

  return reply(200, { configured: true, streamSessionId: streamSession.id, answerSdp });
});

// The browser offers exactly one transceiver, so the SFU needs the mid it
// actually carries rather than an assumed "0".
function firstMid(sdp: string): string {
  return sdp.match(/^a=mid:(.+)$/m)?.[1]?.trim() ?? "0";
}
