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

export interface DescribedFace {
  box: FaceBox;
  descriptor: number[];
}

let loading: Promise<void> | null = null;

export function loadFaceModels(): Promise<void> {
  if (!loading) {
    loading = (async () => {
      // The nobundle build registers the wasm backend but its .wasm binaries
      // are not served, so left to itself tf.ready() tries wasm, logs a
      // failure and only then falls back -- pick webgl (or cpu) up front.
      if (!(await tf.setBackend("webgl"))) await tf.setBackend("cpu");
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

// The expensive pass, run once per capture: every face's landmarks and 128-d
// descriptor in the full-resolution frame. Callers pick the face they want
// (largest box = largest width*height).
export async function describeFaces(
  input: HTMLVideoElement | HTMLCanvasElement,
): Promise<DescribedFace[]> {
  const results = await faceapi
    .detectAllFaces(input, DETECTOR_OPTIONS)
    .withFaceLandmarks(true)
    .withFaceDescriptors();
  return results.map((d) => ({
    box: {
      x: d.detection.box.x,
      y: d.detection.box.y,
      width: d.detection.box.width,
      height: d.detection.box.height,
    },
    descriptor: Array.from(d.descriptor),
  }));
}
