import { describe, expect, it } from "vitest";
import { binarize, otsu, toGray } from "../otsu";

describe("otsu", () => {
  it("splits a bimodal histogram so each mode lands in its own class", () => {
    const gray = new Uint8Array(1000);
    gray.fill(20, 0, 500);
    gray.fill(220, 500, 1000);
    const { threshold, separability } = otsu(gray);
    expect(separability).toBeGreaterThan(0.9);

    // Otsu's class 0 is [0..t] inclusive, so t === 20 is the correct split here.
    const mask = binarize(gray, threshold, true);
    expect(mask.slice(0, 500).every((v) => v === 1)).toBe(true);
    expect(mask.slice(500).every((v) => v === 0)).toBe(true);
  });

  it("reports near-zero separability on a flat image", () => {
    const gray = new Uint8Array(500).fill(128);
    expect(otsu(gray).separability).toBeLessThan(0.01);
  });

  it("converts rgba to luminance", () => {
    const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]);
    const gray = toGray(rgba);
    expect(gray[0]).toBe(255);
    expect(gray[1]).toBe(0);
  });

  it("binarizes with dark as foreground", () => {
    const gray = new Uint8Array([10, 200]);
    const mask = binarize(gray, 128, true);
    expect(Array.from(mask)).toEqual([1, 0]);
  });
});
