// The data-access half of the count aggregation; counts.ts stays pure so the
// arithmetic can be tested without a database.
//
// PostgREST caps one response at max_rows = 1000 (supabase/config.toml:18) and
// says nothing when it truncates, so a single unpaged read of count_minutes
// simply stops being right partway through a shift - one camera freezes the
// "Today" figure after 16h40m, two after ~8h20m. Every screen that totals
// minutes reads them through here so none of them can drift back into that.

import type { MinuteRow } from "./counts";
import { supabase } from "./supabaseClient";

const COLUMNS =
  "minute, count, device_id, station_id, achieved_fps, tracks_created, tracks_counted";
const PAGE = 1000;
const MAX_PAGES = 50;

export interface MinutesResult {
  rows: MinuteRow[];
  truncated: boolean;
}

/**
 * Every count_minutes row at or after `fromIso`, for one station or for all of
 * them, read in pages until the server returns a short one.
 *
 * `truncated` is true only when the page cap stopped the loop - never merely
 * because the final batch happened to fill a page. A caller that sees it has an
 * incomplete total and must say so rather than print a number.
 */
export async function loadMinutesSince(
  fromIso: string,
  stationId?: string,
): Promise<MinutesResult> {
  const rows: MinuteRow[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    let query = supabase().from("count_minutes").select(COLUMNS).gte("minute", fromIso);
    if (stationId) query = query.eq("station_id", stationId);

    const offset = page * PAGE;
    const { data, error } = await query
      // (device_id, minute) is unique, so the tie-break makes the row order
      // total - without it two pages can overlap or skip within one minute.
      .order("minute")
      .order("device_id")
      .range(offset, offset + PAGE - 1);
    if (error) throw error;

    const batch = (data as MinuteRow[]) ?? [];
    rows.push(...batch);
    if (batch.length < PAGE) return { rows, truncated: false };
  }

  return { rows, truncated: true };
}
