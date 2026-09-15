import { describe, expect, it } from "vitest";
import { connectedComponents, filterByArea, medianArea } from "../connectedComponents";

describe("connectedComponents", () => {
  it("finds two separate blobs and their areas", () => {
    const w = 7;
    const h = 3;
    // two 2x2 squares separated by a gap
    const mask = new Uint8Array([1, 1, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0]);
    const blobs = connectedComponents(mask, w, h).sort((a, b) => a.cx - b.cx);
    expect(blobs).toHaveLength(2);
    expect(blobs[0]?.area).toBe(4);
    expect(blobs[1]?.area).toBe(4);
    expect(blobs[0]?.cx).toBeCloseTo(0.5);
    expect(blobs[1]?.cx).toBeCloseTo(5.5);
  });

  it("merges diagonally touching pixels into one blob", () => {
    const mask = new Uint8Array([1, 0, 0, 1]);
    expect(connectedComponents(mask, 2, 2)).toHaveLength(1);
  });

  it("returns nothing for an empty mask", () => {
    expect(connectedComponents(new Uint8Array(16), 4, 4)).toHaveLength(0);
  });

  it("filters by area and computes the median", () => {
    const blobs = [10, 100, 104, 1000].map((area) => ({
      area,
      cx: 0,
      cy: 0,
      minX: 0,
      minY: 0,
      maxX: 1,
      maxY: 1,
    }));
    const kept = filterByArea(blobs, 50, 500);
    expect(kept).toHaveLength(2);
    expect(medianArea(kept)).toBe(102);
  });
});
