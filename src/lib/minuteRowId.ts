// count_minutes carries `unique (device_id, minute)`, so a minute has exactly
// one row no matter how many times it is handed in. A random id per write broke
// that: hiding the page mid-minute flushes the minute so far, counting resumes,
// and the rollover then writes a SECOND row for the same minute, which the
// server rejects 23505 - losing every count after the hide. A reload mid-minute
// does the same.
//
// Deriving the id from (device_id, minute) makes the write idempotent on the
// same key the database is already unique on: the later, fuller write upserts
// over the earlier one instead of colliding with it.
export async function minuteRowId(deviceId: string, minuteKey: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${deviceId}|${minuteKey}`)),
  );
  // Stamp version 5 and the RFC 4122 variant so the value is a well-formed UUID
  // and Postgres accepts it in a uuid column.
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = Array.from(bytes.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
