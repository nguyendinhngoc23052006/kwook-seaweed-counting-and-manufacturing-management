import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function readEnv(env: Record<string, string | undefined>): {
  url: string;
  publishableKey: string;
} {
  const url = env.VITE_SUPABASE_URL;
  const publishableKey = env.VITE_SUPABASE_PUBLISHABLE_KEY;

  const missing: string[] = [];
  if (!url) missing.push("VITE_SUPABASE_URL");
  if (!publishableKey) missing.push("VITE_SUPABASE_PUBLISHABLE_KEY");

  if (missing.length > 0) {
    throw new Error(
      `Missing environment ${missing.length === 1 ? "variable" : "variables"}: ${missing.join(", ")}. ` +
        "Copy .env.example to .env and fill them from the Supabase dashboard " +
        "(Project Settings -> API), or set them as GitHub Actions variables for CI.",
    );
  }

  return { url: url as string, publishableKey: publishableKey as string };
}

let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (!client) {
    const { url, publishableKey } = readEnv(
      import.meta.env as unknown as Record<string, string | undefined>,
    );
    client = createClient(url, publishableKey);
  }
  return client;
}
