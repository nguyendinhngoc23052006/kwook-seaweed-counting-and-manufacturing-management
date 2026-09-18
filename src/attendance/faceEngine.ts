import * as tf from "@tensorflow/tfjs";
import * as faceapi from "@vladmandic/face-api/dist/face-api.esm-nobundle.js";

// The one module that touches TensorFlow.js. It is imported only from the
// attendance camera page (a lazy route chunk), so the org hub, the careers
// site and the counting camera never download it. Everything that can be
// reasoned about without a model -- zone membership, stability, distance --
// lives in ./attendanceLogic.ts as pure functions with tests.

// Served from public/models -- shipped with the app so a factory floor with
// no route to a third-party CDN still boots the camera.
const MODEL_URL = "/models";

export interface FaceBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DetectedFace {
  box: FaceBox;
  score: number;
}

let loading: Promise<void> | null = null;

export function loadFaceModels(): Promise<void> {
  if (!loading) {
    loading = (async () => {
      await tf.ready();
      await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
      await faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL);
      await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
    })().catch((e: unknown) => {
      loading = null;
      throw e;
    });
  }
  return loading;
}

const DETECTOR_OPTIONS = new faceapi.TinyFaceDetectorOptions({
  inputSize: 320,
  scoreThreshold: 0.5,
});

// Cheap per-frame pass: where are the faces and how big are they. Runs on a
// downscaled frame at a few fps; no landmarks, no descriptor.
export async function detectFaces(
  input: HTMLVideoElement | HTMLCanvasElement,
): Promise<DetectedFace[]> {
  const detections = await faceapi.detectAllFaces(input, DETECTOR_OPTIONS);
  return detections.map((d) => ({
    box: { x: d.box.x, y: d.box.y, width: d.box.width, height: d.box.height },
    score: d.score,
  }));
}

// The expensive pass, run once per capture: the single largest face's 128-d
// descriptor. null when no face is found in the full-resolution frame.
export async function describeLargestFace(
  input: HTMLVideoElement | HTMLCanvasElement,
): Promise<number[] | null> {
  const result = await faceapi
    .detectSingleFace(input, DETECTOR_OPTIONS)
    .withFaceLandmarks(true)
    .withFaceDescriptor();
  if (!result) return null;
  return Array.from(result.descriptor);
}
