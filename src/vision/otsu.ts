import type { OtsuResult } from "./types";

export function histogram(gray: Uint8Array): Uint32Array {
  const h = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) {
    const v = gray[i] as number;
    h[v] = (h[v] as number) + 1;
  }
  return h;
}

export function otsu(gray: Uint8Array): OtsuResult {
  const h = histogram(gray);
  const total = gray.length;
  if (total === 0) return { threshold: 128, separability: 0 };

  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * (h[t] as number);

  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 0;

  for (let t = 0; t < 256; t++) {
    wB += h[t] as number;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * (h[t] as number);
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }

  const mean = sum / total;
  let variance = 0;
  for (let t = 0; t < 256; t++) variance += (h[t] as number) * (t - mean) * (t - mean);
  const separability = variance === 0 ? 0 : best / variance;

  return { threshold, separability };
}

export function toGray(rgba: Uint8ClampedArray): Uint8Array {
  const n = rgba.length / 4;
  const gray = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4] as number;
    const g = rgba[i * 4 + 1] as number;
    const b = rgba[i * 4 + 2] as number;
    gray[i] = (r * 299 + g * 587 + b * 114) / 1000;
  }
  return gray;
}

export function binarize(gray: Uint8Array, threshold: number, darkIsForeground = true): Uint8Array {
  const out = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    const on = darkIsForeground
      ? (gray[i] as number) <= threshold
      : (gray[i] as number) > threshold;
    out[i] = on ? 1 : 0;
  }
  return out;
}
