import { describe, expect, it } from "vitest";
import { minuteRowId } from "./minuteRowId";

const DEVICE = "22222222-2222-2222-2222-222222222222";
const OTHER = "33333333-3333-3333-3333-333333333333";
const MINUTE = "2026-09-16T16:30:00Z";

describe("minuteRowId", () => {
  it("is stable for the same device and minute", async () => {
    expect(await minuteRowId(DEVICE, MINUTE)).toBe(await minuteRowId(DEVICE, MINUTE));
  });

  it("differs per minute, so a rollover never overwrites the previous minute", async () => {
    expect(await minuteRowId(DEVICE, MINUTE)).not.toBe(
      await minuteRowId(DEVICE, "2026-09-16T16:31:00Z"),
    );
  });

  it("differs per device, so two cameras on one station never collide", async () => {
    expect(await minuteRowId(DEVICE, MINUTE)).not.toBe(await minuteRowId(OTHER, MINUTE));
  });

  it("is a well-formed v5 UUID Postgres will accept", async () => {
    expect(await minuteRowId(DEVICE, MINUTE)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
