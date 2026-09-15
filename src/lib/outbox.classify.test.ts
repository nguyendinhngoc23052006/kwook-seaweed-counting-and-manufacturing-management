import { describe, expect, it } from "vitest";
import { classifyFlushError } from "./outbox";

describe("classifyFlushError", () => {
  // The race this exists for: two phones signed into the same device account
  // both count the same minute; the loser hits unique (device_id, minute).
  it("treats a unique violation as delivered - the fact is already recorded", () => {
    expect(
      classifyFlushError({
        message:
          'duplicate key value violates unique constraint "count_minutes_device_id_minute_key"',
        code: "23505",
      }),
    ).toBe("delivered");
  });

  it("treats any other server verdict as poison, so it cannot block the queue", () => {
    expect(classifyFlushError({ message: "permission denied", code: "42501" })).toBe("poison");
    expect(classifyFlushError({ message: "not null", code: "23502" })).toBe("poison");
  });

  it("treats a verdict-less failure as offline, so the queue retries later", () => {
    expect(classifyFlushError(new TypeError("Failed to fetch"))).toBe("offline");
    expect(classifyFlushError(undefined)).toBe("offline");
    expect(classifyFlushError({ message: "no code here" })).toBe("offline");
  });
});
