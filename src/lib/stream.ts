import { supabase } from "./supabaseClient";

// The live-view publisher. It exists so a supervisor can glance at a belt; it
// is never allowed to cost the counter anything (rule 5), and it never carries
// audio (rule 6).
//
// Everything about the Realtime app - the App ID, the App Secret, the SFU
// session and track ids - lives in the stream-signal Edge Function. This module
// sends an SDP offer and receives an SDP answer, and that is the whole of its
// knowledge.

// What a wall tile needs to show a belt moving, and nothing beyond it. The
// encoder competes with the vision loop for one phone's CPU, so the stream is
// deliberately the smaller consumer: 320-wide at 12fps next to the 1280-wide
// capture the counter reads.
const MAX_BITRATE_BPS = 400_000;
const MAX_FRAMERATE = 12;
const SCALE_RESOLUTION_DOWN_BY = 4;

// First response to a phone that cannot keep up: half the bitrate, half the
// width again. Counting is not asked to give anything up.
const DEGRADED_BITRATE_BPS = 150_000;
const DEGRADED_SCALE_RESOLUTION_DOWN_BY = 8;

const DISTRESS_POLL_MS = 5_000;
// Two more CPU-limited readings AFTER degrading and the stream goes. A phone
// that is still thermally throttled at 320-wide is a phone that is losing
// frames the counter needed.
const DISTRESS_READINGS_BEFORE_DROP = 2;

// The SFU's HTTP API has no endpoint for trickled ICE candidates, so the offer
// posted to it must be the finished one. The cap stops a phone whose gathering
// stalls from holding the start open.
const ICE_GATHER_CAP_MS = 2_000;

interface ActiveStream {
  connection: RTCPeerConnection;
  sender: RTCRtpSender;
  published: MediaStreamTrack;
  streamSessionId: string;
  monitor: number;
  isDegraded: boolean;
  distressReadings: number;
}

// Optimistic until the Edge Function says otherwise. With no Realtime app
// provisioned the first attempt of a session gets { configured: false } and
// this module goes inert for the life of the page - one POST, no media, and a
// counting loop that never knew the difference.
let isConfigured = true;
let active: ActiveStream | null = null;

export function isStreamConfigured(): boolean {
  return isConfigured;
}

export async function startStream(source: MediaStream, captureSessionId: string): Promise<void> {
  if (!isConfigured || active) return;

  // Rule 6 is structural here, not a default: a source that carries audio is a
  // caller bug, and publishing it with the audio quietly dropped would hide the
  // bug rather than fix it. The Edge Function refuses an audio m-line too.
  if (source.getAudioTracks().length > 0) {
    throw new Error("Live view refuses a source carrying an audio track");
  }
  const [camera] = source.getVideoTracks();
  if (!camera) throw new Error("Live view needs a video track");

  // A clone, never the counter's own track. The clone shares the camera source
  // but is a separate consumer, so nothing done to the published track - not
  // setParameters, not stopping it, not closing the connection - can reach back
  // into the track the vision loop is reading.
  const published = camera.clone();
  const connection = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
  });
  try {
    const transceiver = connection.addTransceiver(published, {
      direction: "sendonly",
      sendEncodings: [
        {
          maxBitrate: MAX_BITRATE_BPS,
          maxFramerate: MAX_FRAMERATE,
          scaleResolutionDownBy: SCALE_RESOLUTION_DOWN_BY,
        },
      ],
    });
    await connection.setLocalDescription(await connection.createOffer());
    await waitForIceCandidates(connection);

    const { data, error } = await supabase().functions.invoke("stream-signal", {
      body: { action: "publish", captureSessionId, sdp: connection.localDescription?.sdp ?? "" },
    });
    if (error) throw error;
    const reply = readPublishReply(data);
    // Not an error: no Realtime app is provisioned, so the feature switches
    // itself off for the life of the page and the camera carries on counting.
    if (!reply) {
      isConfigured = false;
      published.stop();
      connection.close();
      return;
    }
    await connection.setRemoteDescription({ type: "answer", sdp: reply.answerSdp });

    active = {
      connection,
      sender: transceiver.sender,
      published,
      streamSessionId: reply.streamSessionId,
      monitor: window.setInterval(checkForDistress, DISTRESS_POLL_MS),
      isDegraded: false,
      distressReadings: 0,
    };
  } catch (e: unknown) {
    published.stop();
    connection.close();
    throw e;
  }
}

// Closing the peer connection is what actually stops the media; the row is
// closed separately because a device may not UPDATE stream_sessions - only the
// Edge Function's service role may.
export function stopStream(): void {
  const current = active;
  if (!current) return;
  active = null;
  window.clearInterval(current.monitor);
  current.published.stop();
  current.connection.close();
  void supabase()
    .functions.invoke("stream-signal", {
      body: { action: "stop", streamSessionId: current.streamSessionId },
    })
    .catch(() => undefined);
}

function checkForDistress(): void {
  const current = active;
  if (!current) return;
  void (async () => {
    // "cpu" is what a thermally throttled phone reports: the encoder cannot
    // keep up, which on a shared camera means dropped frames for the counter.
    if ((await readQualityLimitation(current.connection)) !== "cpu") {
      current.distressReadings = 0;
      return;
    }
    if (active !== current) return;
    if (!current.isDegraded) {
      current.isDegraded = true;
      current.distressReadings = 0;
      await limitSender(current.sender, DEGRADED_BITRATE_BPS, DEGRADED_SCALE_RESOLUTION_DOWN_BY);
      return;
    }
    current.distressReadings += 1;
    if (current.distressReadings >= DISTRESS_READINGS_BEFORE_DROP) stopStream();
  })().catch(() => undefined);
}

async function limitSender(
  sender: RTCRtpSender,
  maxBitrate: number,
  scaleResolutionDownBy: number,
): Promise<void> {
  const parameters = sender.getParameters();
  const [encoding] = parameters.encodings;
  if (!encoding) return;
  encoding.maxBitrate = maxBitrate;
  encoding.maxFramerate = MAX_FRAMERATE;
  encoding.scaleResolutionDownBy = scaleResolutionDownBy;
  await sender.setParameters(parameters);
}

async function readQualityLimitation(connection: RTCPeerConnection): Promise<string | null> {
  let limitation: string | null = null;
  const report = await connection.getStats();
  report.forEach((entry: unknown) => {
    if (entry === null || typeof entry !== "object") return;
    const stat = entry as { type?: unknown; kind?: unknown; qualityLimitationReason?: unknown };
    if (stat.type !== "outbound-rtp" || stat.kind !== "video") return;
    if (typeof stat.qualityLimitationReason === "string") {
      limitation = stat.qualityLimitationReason;
    }
  });
  return limitation;
}

function waitForIceCandidates(connection: RTCPeerConnection): Promise<void> {
  if (connection.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      window.clearTimeout(cap);
      connection.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    };
    const onChange = () => {
      if (connection.iceGatheringState === "complete") finish();
    };
    const cap = window.setTimeout(finish, ICE_GATHER_CAP_MS);
    connection.addEventListener("icegatheringstatechange", onChange);
  });
}

// Null means "not provisioned", which is a normal answer, not a failure.
function readPublishReply(data: unknown): { streamSessionId: string; answerSdp: string } | null {
  if (data === null || typeof data !== "object") return null;
  const reply = data as { configured?: unknown; streamSessionId?: unknown; answerSdp?: unknown };
  if (reply.configured !== true) return null;
  if (typeof reply.streamSessionId !== "string" || typeof reply.answerSdp !== "string") return null;
  return { streamSessionId: reply.streamSessionId, answerSdp: reply.answerSdp };
}
