// Aggregation for the station screen. Pure on purpose: the counts are the
// product, so the arithmetic that turns minute rows into a figure has to be
// testable without a database.

const MINUTE_MS = 60_000;

export interface MinuteRow {
  minute: string;
  count: number;
  device_id: string;
  // Where the session that wrote this minute was pointed. A phone runs one
  // station today and another tomorrow, so the camera's current default cannot
  // stand in for it.
  station_id: string | null;
  achieved_fps: number | null;
  tracks_created: number;
  tracks_counted: number;
}

export interface MinutePoint {
  minute: string;
  count: number;
}

// Postgres hands back a timestamptz string. Everything here works on the epoch
// ms of the minute's start so that two cameras on one station, writing the same
// minute in different formats or offsets, land in the same bucket.
function minuteStart(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? Number.NaN : Math.floor(t / MINUTE_MS) * MINUTE_MS;
}

// The minutes that actually reported, regardless of how many cameras reported
// them or whether they reported zero. This is the numerator of coverage.
function reportedMinutes(rows: MinuteRow[]): Set<number> {
  const minutes = new Set<number>();
  for (const row of rows) {
    const t = minuteStart(row.minute);
    if (!Number.isNaN(t)) minutes.add(t);
  }
  return minutes;
}

export function totalFor(rows: MinuteRow[]): number {
  let total = 0;
  for (const row of rows) total += row.count;
  return total;
}

/**
 * One point per minute from `fromIso` to `toIso`, both ends inclusive, with
 * every minute nobody reported filled in as zero.
 *
 * Without the fill a dead camera just yields a shorter series, which draws as a
 * narrower chart and reads as "nothing happened here" - the outage disappears
 * into the axis. Filled, it is a visible trough. The fill deliberately makes a
 * missing minute and a genuinely-zero minute look the same on the bars, which
 * is why `coverage` exists to tell them apart.
 */
export function perMinuteSeries(rows: MinuteRow[], fromIso: string, toIso: string): MinutePoint[] {
  const from = minuteStart(fromIso);
  const to = minuteStart(toIso);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return [];

  const sums = new Map<number, number>();
  for (const row of rows) {
    const t = minuteStart(row.minute);
    if (Number.isNaN(t) || t < from || t > to) continue;
    sums.set(t, (sums.get(t) ?? 0) + row.count);
  }

  const series: MinutePoint[] = [];
  for (let t = from; t <= to; t += MINUTE_MS) {
    series.push({ minute: new Date(t).toISOString(), count: sums.get(t) ?? 0 });
  }
  return series;
}

/** Counts divided by the minutes that actually reported, x60. */
export function ratePerHour(rows: MinuteRow[]): number {
  const covered = reportedMinutes(rows).size;
  if (covered === 0) return 0;
  return (totalFor(rows) / covered) * 60;
}

/**
 * Share of `expectedMinutes` that reported, 0..1. The honest denominator: a
 * station offline for 30% of a shift counted less because it was not watching,
 * not because it was slow, and the figures above it mean nothing without this.
 */
export function coverage(rows: MinuteRow[], expectedMinutes: number): number {
  if (!Number.isFinite(expectedMinutes) || expectedMinutes <= 0) return 0;
  return Math.min(1, reportedMinutes(rows).size / expectedMinutes);
}
