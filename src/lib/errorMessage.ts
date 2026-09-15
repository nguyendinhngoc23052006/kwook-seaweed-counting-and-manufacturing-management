// Supabase does not reject with an Error for database failures. A PostgrestError
// is a PLAIN OBJECT - { message, details, hint, code } - so the usual
//
//   e instanceof Error ? e.message : String(e)
//
// falls to String(e) and renders the literal text "[object Object]", throwing
// away the only useful information. That is exactly how a 403 "permission
// denied for table profiles" reached a user as an unreadable red box.
//
// Pull the message out by SHAPE rather than by class, and keep the SQLSTATE
// code: "permission denied for table profiles (42501)" is diagnosable, the
// bare message alone is not.
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;

  if (e !== null && typeof e === "object") {
    const shape = e as { message?: unknown; code?: unknown };
    if (typeof shape.message === "string" && shape.message.length > 0) {
      const code =
        typeof shape.code === "string" && shape.code.length > 0 ? ` (${shape.code})` : "";
      return `${shape.message}${code}`;
    }
    try {
      return JSON.stringify(e);
    } catch {
      return String(e);
    }
  }

  return String(e);
}
