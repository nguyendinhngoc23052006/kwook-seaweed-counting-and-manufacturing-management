import { describe, expect, it } from "vitest";
import { ordinalBetween } from "./ranks";

// The seeded rungs are 1000 apart precisely so a new one slots between two
// neighbours without renumbering either. These are the cases a human hits
// when they say "put a new grade between Manager and Supervisor".
describe("ordinalBetween", () => {
  it("puts the first rank in the middle of the range", () => {
    expect(ordinalBetween(null, null)).toBe(5000);
  });

  it("adds a rung above the most senior one", () => {
    expect(ordinalBetween(null, 1000)).toBe(0);
  });

  it("adds a rung below the most junior one", () => {
    expect(ordinalBetween(9000, null)).toBe(10000);
  });

  it("lands on the midpoint between two neighbours", () => {
    expect(ordinalBetween(5000, 7000)).toBe(6000);
  });

  it("still finds room when the neighbours are close", () => {
    expect(ordinalBetween(5000, 5002)).toBe(5001);
  });

  // unique(ordinal) would reject the collision anyway; this turns a 23505 into
  // a sentence the caller can show.
  it("refuses when two neighbours are adjacent", () => {
    expect(() => ordinalBetween(5000, 5001)).toThrow(/no room/);
  });

  it("refuses when the neighbours are the same rung", () => {
    expect(() => ordinalBetween(5000, 5000)).toThrow(/no room/);
  });
});
