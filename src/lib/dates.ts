// A date with no clock on it means the end of that day, where the person who
// chose it lives.
//
// An <input type="date"> hands back "2026-09-20", and `new Date("2026-09-20")`
// reads that as UTC midnight -- 07:00 in Hà Nội. A task due today would turn red
// over breakfast, and a job posting would stop taking applications before lunch
// on the day it told people was the deadline. Both screens make that promise,
// which is why this lives here rather than in either of them.
export function endOfDayIso(date: string): string {
  const parts = date.split("-").map(Number);
  const year = parts[0] ?? 0;
  const month = parts[1] ?? 1;
  const day = parts[2] ?? 1;
  return new Date(year, month - 1, day, 23, 59, 59, 999).toISOString();
}
