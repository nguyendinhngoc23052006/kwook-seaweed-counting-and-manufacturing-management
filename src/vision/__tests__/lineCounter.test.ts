import { describe, expect, it } from "vitest";
import { LineCounter } from "../lineCounter";
import type { Blob } from "../types";

const blobAt = (cx: number, cy: number): Blob => ({
  area: 100,
  cx,
  cy,
  minX: cx - 5,
  minY: cy - 5,
  maxX: cx + 5,
  maxY: cy + 5,
});

const config = {
  lineY: 50,
  beltDy: 10,
  gateRadius: 15,
  minTrackAge: 3,
  maxMissed: 2,
};

describe("LineCounter", () => {
  it("counts one leaf crossing the line exactly once", () => {
    const counter = new LineCounter(config);
    for (const cy of [10, 20, 30, 40, 50, 60, 70]) {
      counter.update([blobAt(20, cy)]);
    }
    expect(counter.stats().counted).toBe(1);
  });

  it("counts several leaves crossing side by side in the same frame", () => {
    const counter = new LineCounter(config);
    for (const cy of [10, 20, 30, 40, 50, 60]) {
      counter.update([blobAt(20, cy), blobAt(60, cy), blobAt(100, cy)]);
    }
    expect(counter.stats().counted).toBe(3);
  });

  it("does not count a leaf that never reaches the line", () => {
    const counter = new LineCounter(config);
    for (const cy of [10, 20, 30, 40]) {
      counter.update([blobAt(20, cy)]);
    }
    expect(counter.stats().counted).toBe(0);
  });

  it("does not count a track younger than minTrackAge", () => {
    const counter = new LineCounter({ ...config, minTrackAge: 10 });
    for (const cy of [10, 20, 30, 40, 50, 60]) {
      counter.update([blobAt(20, cy)]);
    }
    expect(counter.stats().counted).toBe(0);
  });

  it("records tracks that vanish before crossing", () => {
    const counter = new LineCounter(config);
    for (const cy of [10, 20, 30]) counter.update([blobAt(20, cy)]);
    for (let i = 0; i < 5; i++) counter.update([]);
    const stats = counter.stats();
    expect(stats.counted).toBe(0);
    expect(stats.agedOutUncounted).toBe(1);
  });

  it("reports created and counted so the health ratio is observable", () => {
    const counter = new LineCounter(config);
    for (const cy of [10, 20, 30, 40, 50, 60]) counter.update([blobAt(20, cy)]);
    const stats = counter.stats();
    expect(stats.created).toBe(1);
    expect(stats.counted).toBe(1);
  });
});
