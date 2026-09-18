import { describe, expect, it } from "vitest";
import { endOfDayIso, startOfDayIso } from "./dates";

const DAY = "2026-09-20";

describe("endOfDayIso", () => {
  it("ends at 23:59:59.999 local", () => {
    const d = new Date(endOfDayIso(DAY));
    expect(d.getHours()).toBe(23);
    expect(d.getMinutes()).toBe(59);
    expect(d.getSeconds()).toBe(59);
    expect(d.getMilliseconds()).toBe(999);
  });
});

describe("startOfDayIso", () => {
  it("starts at local 00:00:00.000", () => {
    const d = new Date(startOfDayIso(DAY));
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
    expect(d.getMilliseconds()).toBe(0);
  });
});

describe("startOfDayIso vs endOfDayIso", () => {
  it("starts before it ends, for the same day", () => {
    expect(new Date(startOfDayIso(DAY)).getTime()).toBeLessThan(
      new Date(endOfDayIso(DAY)).getTime(),
    );
  });
});
