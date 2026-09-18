import { describe, expect, it } from "vitest";
import { endOfDayIso, vietnamDayStartIso } from "./dates";

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

describe("vietnamDayStartIso", () => {
  it("returns the UTC instant of Vietnam midnight", () => {
    expect(vietnamDayStartIso("2026-09-14")).toBe("2026-09-13T17:00:00.000Z");
  });

  it("adds plusDays before taking Vietnam midnight", () => {
    expect(vietnamDayStartIso("2026-09-14", 1)).toBe("2026-09-14T17:00:00.000Z");
  });

  it("rolls over a month boundary", () => {
    expect(vietnamDayStartIso("2026-09-30", 1)).toBe("2026-09-30T17:00:00.000Z");
  });
});
