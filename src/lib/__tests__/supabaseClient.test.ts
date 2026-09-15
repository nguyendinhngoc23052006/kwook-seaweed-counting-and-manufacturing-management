import { describe, expect, it } from "vitest";
import { readEnv } from "../supabaseClient";

describe("readEnv", () => {
  it("builds from the VITE_ prefixed names", () => {
    const result = readEnv({
      VITE_SUPABASE_URL: "https://example.supabase.co",
      VITE_SUPABASE_PUBLISHABLE_KEY: "pk_test",
    });
    expect(result.url).toBe("https://example.supabase.co");
    expect(result.publishableKey).toBe("pk_test");
  });

  it("names every missing variable in the error", () => {
    expect(() => readEnv({})).toThrow(/VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY/);
  });

  it("names only the one that is missing", () => {
    expect(() => readEnv({ VITE_SUPABASE_URL: "https://x.supabase.co" })).toThrow(
      /Missing environment variable: VITE_SUPABASE_PUBLISHABLE_KEY/,
    );
  });
});
