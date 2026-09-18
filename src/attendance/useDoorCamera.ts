import type { RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../lib/errorMessage";
import {
  type AttendanceConfig,
  isCaptureCandidate,
  largestFace,
  StabilityGate,
} from "./attendanceLogic";
import { type DescribedFace, describeFaces, detectFaces, loadFaceModels } from "./faceEngine";

// ~5 fps: fast enough that a stability gate of a few frames still resolves in
// well under a second, slow enough to leave the main thread free for the video
// element and the capture RPC.
const DETECT_INTERVAL_MS = 200;
// How long the light gets to land on the face before the frame is read.
const FLASH_LEAD_MS = 150;

export type DoorCameraPhase = "loading-models" | "starting-camera" | "running" | "error";

// MediaTrackConstraintSet has no torch field in lib.dom -- it is a real,
// widely-supported constraint browsers just haven't typed yet.
interface TorchConstraintSet extends MediaTrackConstraintSet {
  torch?: boolean;
}

export interface UseDoorCameraResult {
  videoRef: RefObject<HTMLVideoElement | null>;
  phase: DoorCameraPhase;
  error: string | null;
  candidate: boolean;
  flashing: boolean;
  actualFacing: "user" | "environment" | null;
}

function setTorch(track: MediaStreamTrack | null, on: boolean): void {
  if (!track) return;
  // Most phones refuse a torch constraint outright; the white screen the page
  // paints while `flashing` is the light that always works.
  try {
    const advanced: TorchConstraintSet[] = [{ torch: on }];
    void track
      .applyConstraints({ advanced: advanced as MediaTrackConstraintSet[] })
      .catch(() => undefined);
  } catch {
    // ignored -- see above
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function useDoorCamera({
  config,
  onCapture,
  holdMs,
  enabled,
}: {
  config: AttendanceConfig;
  onCapture: (embedding: number[]) => Promise<void>;
  // After a capture the zone is ignored for this long, so one person standing
  // at the door is captured once, and the page has time to show the verdict.
  holdMs: number;
  // A revoked door never opens the camera or takes the wake lock.
  enabled: boolean;
}): UseDoorCameraResult {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const configRef = useRef(config);
  configRef.current = config;
  const onCaptureRef = useRef(onCapture);
  onCaptureRef.current = onCapture;
  const holdRef = useRef(holdMs);
  holdRef.current = holdMs;

  const [phase, setPhase] = useState<DoorCameraPhase>("loading-models");
  const [error, setError] = useState<string | null>(null);
  const [candidate, setCandidate] = useState(false);
  const [flashing, setFlashing] = useState(false);
  const [actualFacing, setActualFacing] = useState<"user" | "environment" | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stream: MediaStream | null = null;
    let track: MediaStreamTrack | null = null;
    let wakeLock: WakeLockSentinel | null = null;
    const gate = new StabilityGate(configRef.current.stableFrames);
    let busy = false;

    const acquireWakeLock = () => {
      if (!("wakeLock" in navigator)) return;
      navigator.wakeLock
        .request("screen")
        .then((lock) => {
          if (stopped) void lock.release().catch(() => undefined);
          else wakeLock = lock;
        })
        .catch(() => undefined);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") acquireWakeLock();
    };

    // Light first, then read the frame: the flash is both the "picture taken"
    // signal (no audio, ever) and the light the descriptor is computed under.
    const capture = async (video: HTMLVideoElement) => {
      const flashMs = configRef.current.flashMs;
      if (flashMs > 0) {
        setFlashing(true);
        setTorch(track, true);
        setTimeout(() => {
          setFlashing(false);
          setTorch(track, false);
        }, flashMs);
        await sleep(Math.min(FLASH_LEAD_MS, flashMs));
      }
      const faces = await describeFaces(video);
      let best: DescribedFace | null = null;
      for (const face of faces) {
        if (!isCaptureCandidate(face.box, video.videoWidth, video.videoHeight, configRef.current)) {
          continue;
        }
        if (!best || face.box.width * face.box.height > best.box.width * best.box.height) {
          best = face;
        }
      }
      await onCaptureRef.current(best?.descriptor ?? []);
      await sleep(holdRef.current);
    };

    const loop = async () => {
      if (stopped) return;
      try {
        const video = videoRef.current;
        if (video) {
          // The <video> element only mounts once the boot sequence reaches
          // "running"; attach the already-open stream here, on the first
          // tick that sees it, rather than at boot when the ref is null.
          if (stream && video.srcObject !== stream) {
            video.srcObject = stream;
            await video.play();
          }
          if (video.videoWidth > 0) {
            const faces = await detectFaces(video);
            const box = largestFace(faces.map((f) => f.box));
            const isCandidate =
              box !== null &&
              isCaptureCandidate(box, video.videoWidth, video.videoHeight, configRef.current);
            setCandidate(isCandidate);
            if (gate.update(isCandidate) && !busy) {
              busy = true;
              try {
                await capture(video);
              } finally {
                busy = false;
                gate.reset();
              }
            }
          }
        }
      } catch (e: unknown) {
        if (stopped) return;
        setError(errorMessage(e));
        setPhase("error");
        return;
      }
      if (!stopped) timer = setTimeout(() => void loop(), DETECT_INTERVAL_MS);
    };

    void (async () => {
      try {
        setPhase("loading-models");
        await loadFaceModels();
        if (stopped) return;

        setPhase("starting-camera");
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: configRef.current.facing,
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
        if (stopped) {
          for (const t of stream.getTracks()) t.stop();
          return;
        }
        track = stream.getVideoTracks()[0] ?? null;
        const facingMode = track?.getSettings().facingMode;
        setActualFacing(facingMode === "user" || facingMode === "environment" ? facingMode : null);
        // The <video> element isn't mounted yet (phase is still
        // "starting-camera"); the loop attaches srcObject once it is.
        acquireWakeLock();
        document.addEventListener("visibilitychange", onVisibilityChange);
        setPhase("running");
        void loop();
      } catch (e: unknown) {
        if (!stopped) {
          setError(errorMessage(e));
          setPhase("error");
        }
      }
    })();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      setTorch(track, false);
      for (const t of stream?.getTracks() ?? []) t.stop();
      const video = videoRef.current;
      if (video) video.srcObject = null;
      void wakeLock?.release().catch(() => undefined);
    };
    // Reruns only when `enabled` flips: config, onCapture and holdMs are read
    // through the refs kept current above, so a re-render never restarts the
    // camera on its own.
  }, [enabled]);

  return { videoRef, phase, error, candidate, flashing, actualFacing };
}
