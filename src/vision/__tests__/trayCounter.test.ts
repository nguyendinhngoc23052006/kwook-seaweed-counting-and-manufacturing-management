import { describe, expect, it } from "vitest";
import { countTray } from "../trayCounter";

function trayWithSquares(w: number, h: number, origins: Array<[number, number]>, size: number) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  rgba.fill(255);
  for (const [ox, oy] of origins) {
    for (let y = oy; y < oy + size; y++) {
      for (let x = ox; x < ox + size; x++) {
        const i = (y * w + x) * 4;
        rgba[i] = 10;
        rgba[i + 1] = 10;
        rgba[i + 2] = 10;
      }
    }
  }
  return rgba;
}

describe("countTray", () => {
  it("counts three separated leaves of equal size", () => {
    const w = 100;
    const h = 40;
    const rgba = trayWithSquares(
      w,
      h,
      [
        [5, 10],
        [40, 10],
        [75, 10],
      ],
      12,
    );
    const result = countTray(rgba, w, h, { minArea: 20 });
    expect(result.count).toBe(3);
    expect(result.blobCount).toBe(3);
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it("splits one oversized cluster by the median leaf area", () => {
    const w = 140;
    const h = 40;
    // three singles establish the median; one double-width blob must score 2
    const rgba = trayWithSquares(
      w,
      h,
      [
        [5, 10],
        [30, 10],
        [55, 10],
      ],
      12,
    );
    for (let y = 10; y < 22; y++) {
      for (let x = 85; x < 109; x++) {
        const i = (y * w + x) * 4;
        rgba[i] = 10;
        rgba[i + 1] = 10;
        rgba[i + 2] = 10;
      }
    }
    const result = countTray(rgba, w, h, { minArea: 20 });
    expect(result.blobCount).toBe(4);
    expect(result.count).toBe(5);
  });

  it("returns zero for an empty tray", () => {
    const rgba = new Uint8ClampedArray(40 * 40 * 4).fill(255);
    expect(countTray(rgba, 40, 40, { minArea: 20 }).count).toBe(0);
  });
});
