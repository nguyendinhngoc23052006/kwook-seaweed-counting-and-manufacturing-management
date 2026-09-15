import { connectedComponents, filterByArea, medianArea } from "./connectedComponents";
import { close, open } from "./morphology";
import { binarize, otsu, toGray } from "./otsu";
import type { Blob } from "./types";

export interface TrayCountResult {
  count: number;
  confidence: number;
  blobCount: number;
  medianLeafArea: number;
  threshold: number;
  separability: number;
  totalArea: number;
}

export interface TrayCountOptions {
  minArea: number;
  maxArea: number;
  darkIsForeground: boolean;
}

const DEFAULTS: TrayCountOptions = {
  minArea: 40,
  maxArea: Number.POSITIVE_INFINITY,
  darkIsForeground: true,
};

function touchesEdge(b: Blob, w: number, h: number): boolean {
  return b.minX <= 0 || b.minY <= 0 || b.maxX >= w - 1 || b.maxY >= h - 1;
}

export function countTray(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  options: Partial<TrayCountOptions> = {},
): TrayCountResult {
  const opts = { ...DEFAULTS, ...options };
  const gray = toGray(rgba);
  const { threshold, separability } = otsu(gray);
  const mask = close(open(binarize(gray, threshold, opts.darkIsForeground), w, h), w, h);

  const blobs = filterByArea(connectedComponents(mask, w, h), opts.minArea, opts.maxArea);
  const median = medianArea(blobs);

  if (blobs.length === 0 || median === 0) {
    return {
      count: 0,
      confidence: separability,
      blobCount: 0,
      medianLeafArea: 0,
      threshold,
      separability,
      totalArea: 0,
    };
  }

  let count = 0;
  let ambiguousArea = 0;
  let totalArea = 0;
  let edgeTouching = 0;

  for (const b of blobs) {
    totalArea += b.area;
    const ratio = b.area / median;
    const rounded = Math.max(1, Math.round(ratio));
    count += rounded;
    if (Math.abs(ratio - rounded) > 0.25) ambiguousArea += b.area;
    if (touchesEdge(b, w, h)) edgeTouching++;
  }

  const ambiguityPenalty = totalArea === 0 ? 0 : ambiguousArea / totalArea;
  const edgePenalty = edgeTouching / blobs.length;
  const confidence = Math.max(
    0,
    Math.min(1, separability * (1 - ambiguityPenalty) * (1 - 0.5 * edgePenalty)),
  );

  return {
    count,
    confidence,
    blobCount: blobs.length,
    medianLeafArea: median,
    threshold,
    separability,
    totalArea,
  };
}
