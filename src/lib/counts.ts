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
  // Server receipt minus the phone-built minute key, in seconds (migration
  // 20260917092000). Null on rows written before that column existed.
  skew_seconds: number | null;
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

// A row is written at the END of the minute it describes and posted straight
// after, so a correctly-set phone lands about one minute of skew.
const PROMPT_DELIVERY_SECONDS = 60;

// Three minutes out is already enough to file a minute's leaves under the wrong
// minute, which is the whole failure being made visible. Below that the noise of
// upload timing would cry wolf on every station.
export const CLOCK_DRIFT_SECONDS = 180;

/**
 * How far this camera's clock appears to be out, in seconds, or null when no row
 * carried a skew. Positive means the phone is running behind the server.
 *
 * The SMALLEST skew in the window is used, not the average or the largest: a
 * queued row flushed after an outage is delivered late, and lateness only ever
 * ADDS to skew, so a mean would read a recovered outage as a broken clock. The
 * smallest is the closest the phone ever came to delivering promptly, and it is
 * the only part of the spread that delay cannot explain away.
 */
export function clockDriftSeconds(rows: MinuteRow[]): number | null {
  let smallest: number | null = null;
  for (const row of rows) {
    if (row.skew_seconds === null) continue;
    if (smallest === null || row.skew_seconds < smallest) smallest = row.skew_seconds;
  }
  return smallest === null ? null : smallest - PROMPT_DELIVERY_SECONDS;
}

/**
 * Whether this camera's minutes are being filed against the wrong wall-clock
 * time. A drifting phone writes perfectly well-formed rows against minutes that
 * never happened at the station, so nothing else on a screen reveals it.
 */
export function isClockDrifting(rows: MinuteRow[]): boolean {
  const drift = clockDriftSeconds(rows);
  return drift !== null && Math.abs(drift) > CLOCK_DRIFT_SECONDS;
}
