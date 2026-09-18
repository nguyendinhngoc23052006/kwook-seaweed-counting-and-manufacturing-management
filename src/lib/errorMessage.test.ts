import { describe, expect, it } from "vitest";
import { errorMessage } from "./errorMessage";

describe("errorMessage", () => {
  it("reads a real Error", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  // The regression this file exists for.
  it("reads a PostgrestError, which is a plain object and not an Error", () => {
    const postgrestError = {
      message: "permission denied for table profiles",
      details: null,
      hint: null,
      code: "42501",
    };
    expect(errorMessage(postgrestError)).toBe("permission denied for table profiles (42501)");
    expect(errorMessage(postgrestError)).not.toContain("[object Object]");
  });

  it("omits the code when there isn't one", () => {
    expect(errorMessage({ message: "nope" })).toBe("nope");
  });

  it("passes a string through", () => {
    expect(errorMessage("plain")).toBe("plain");
  });

  it("never returns [object Object] for a messageless object", () => {
    expect(errorMessage({ weird: true })).toBe('{"weird":true}');
  });

  it("survives a circular object", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(errorMessage(circular)).toBe("[object Object]");
  });

  it("handles null and undefined", () => {
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage(undefined)).toBe("undefined");
  });
});
