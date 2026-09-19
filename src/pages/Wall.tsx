import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Shell, { atLeast } from "../components/Shell";
import { isClockDrifting, type MinuteRow, totalFor } from "../lib/counts";
import { errorMessage } from "../lib/errorMessage";
import { functionLabel } from "../lib/functionsCatalog";
import { loadMinutesSince } from "../lib/loadMinutes";
import type { Profile } from "../lib/session";
import { supabase } from "../lib/supabaseClient";
import { type CaptureSession, loadOpenSessions } from "../services/captureSessions";

interface StationRow {
  id: string;
  name: string;
  line_id: string | null;
}

interface LineRow {
  id: string;
  name: string;
}

interface LineGroup {
  key: string;
  name: string;
  stations: StationRow[];
}

// A line is a row now, not the text on a station (migration 20260917091000), so
// "Line Plant" and "line plant" are one heading with one total instead of two
// half-empty ones. Grouping walks the lines table, which also fixes the order:
// the floor's own order, not whatever the station names sort into.
function groupByLine(stations: StationRow[], lines: LineRow[]): LineGroup[] {
  const byLine = new Map<string, StationRow[]>();
  const unplaced: StationRow[] = [];
  for (const station of stations) {
    if (!station.line_id) {
      unplaced.push(station);
      continue;
    }
    const list = byLine.get(station.line_id);
    if (list) list.push(station);
    else byLine.set(station.line_id, [station]);
  }

  const groups: LineGroup[] = [];
  for (const line of lines) {
    const list = byLine.get(line.id);
    if (list) groups.push({ key: line.id, name: line.name, stations: list });
  }
  // A station can be created before its line is chosen, and its counts are real
  // either way. Last, and named, so nobody reads the wall as complete.
  if (unplaced.length > 0)
    groups.push({ key: "unplaced", name: "No line yet", stations: unplaced });
  return groups;
}

// What a station is doing now is its open capture_session and nothing else: the
// owner's assignment on the devices row says where a camera BELONGS, and the
// session says it is actually recording there. No open session is "off" - the
// end of a shift, not a fault, so it never ages into stale.
//
// A running session is graded on its own evidence (last_evidence_at, advanced by
// every heartbeat), which is the same clock the reaper closes it with. A session
// that has not beaten yet is as old as its start.
function sessionState(session: CaptureSession | undefined): { label: string; cls: string } {
  if (!session) return { label: "off", cls: "idle" };
  const evidence = session.last_evidence_at ?? session.started_at;
  const minutes = (Date.now() - new Date(evidence).getTime()) / 60000;
  if (minutes > 10) return { label: `silent ${Math.round(minutes)}m`, cls: "crit" };
  if (minutes > 2) return { label: `quiet ${Math.round(minutes)}m`, cls: "warn" };
  return { label: "running", cls: "ok" };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function cameraLine(session: CaptureSession): string {
  // device_label is the snapshot the insert trigger took; sessions started
  // before it existed carry none.
  const label = session.device_label ?? "Camera";
  return `${label} · ${functionLabel(session.camera_function)} · since ${hhmm(session.started_at)}`;
}

export default function Wall({ profile }: { profile: Profile }) {
  const [stations, setStations] = useState<StationRow[]>([]);
  const [lines, setLines] = useState<LineRow[]>([]);
  const [sessions, setSessions] = useState<CaptureSession[]>([]);
  const [minutes, setMinutes] = useState<MinuteRow[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      // Recomputed on every pass so the wall rolls over at midnight on its own.
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);

      try {
        const [stationResult, lineResult, openSessions, minuteResult] = await Promise.all([
          supabase().from("camera_stations").select("id, name, line_id").order("name"),
          supabase().from("camera_lines").select("id, name").order("name"),
          // No devices read: a session carries the phone's label and its own
          // evidence, and revoking a phone closes its sessions in the database
          // (migration 20260916170000), so an open session is a live camera.
          loadOpenSessions(),
          loadMinutesSince(dayStart.toISOString()),
        ]);
        if (cancelled) return;

        const failure = stationResult.error ?? lineResult.error;
        if (failure) {
          setError(errorMessage(failure));
          setLoading(false);
          return;
        }
        setError(null);
        setStations((stationResult.data as StationRow[]) ?? []);
        setLines((lineResult.data as LineRow[]) ?? []);
        setSessions(openSessions);
        setMinutes(minuteResult.rows);
        setTruncated(minuteResult.truncated);
        setLoading(false);
      } catch (failure) {
        // loadMinutesSince and loadOpenSessions throw where the other two return
        // their error in-band.
        if (cancelled) return;
        setError(errorMessage(failure));
        setLoading(false);
      }
    };

    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // One open session per station is a database guarantee now
  // (capture_sessions_one_open_per_station), so a station has one camera or
  // none, and two phones can no longer double a station's total.
  const sessionByStation = new Map<string, CaptureSession>();
  const unstationed: CaptureSession[] = [];
  for (const session of sessions) {
    if (session.station_id) sessionByStation.set(session.station_id, session);
    else unstationed.push(session);
  }

  // Today's totals are history, not liveness: a minute belongs to the station
  // the server stamped on it when it arrived, so a camera reassigned at noon
  // leaves the morning where it was counted.
  const minutesByStation = new Map<string, MinuteRow[]>();
  for (const row of minutes) {
    if (!row.station_id) continue;
    const list = minutesByStation.get(row.station_id);
    if (list) list.push(row);
    else minutesByStation.set(row.station_id, [row]);
  }

  const groups = groupByLine(stations, lines);

  return (
    <Shell profile={profile} active="wall">
      <div className="stack">
        <div className="section__head">
          <h1 className="h1">Today</h1>
          <span className="muted">
            {plural(stations.length, "station")} on {plural(lines.length, "line")} · updates every
            15s
          </span>
        </div>

        {error ? (
          <div className="banner banner--crit" role="alert">
            {error}
          </div>
        ) : null}

        {truncated ? (
          <div className="banner banner--warn">
            Today has more minutes than one read can carry, so every total below is partial.
          </div>
        ) : null}

        {loading ? (
          <div className="section">
            <h2 className="section__title skeleton">Loading lines</h2>
            <div className="floor-grid floor-grid--wide">
              {["a", "b", "c"].map((key) => (
                <div className="card stack" key={key}>
                  <span className="skeleton">Station name</span>
                  <span className="figure skeleton">0000</span>
                  <span className="skeleton">Cameras</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {!loading && stations.length === 0 ? (
          <div className="empty">
            <h2 className="empty__title">No stations yet</h2>
            <p className="empty__body">
              The wall shows what each station on each line produced today. Nothing can be counted
              until the floor exists: a station is the spot a camera points at — a tray table, a
              stretch of belt, a doorway.
            </p>
            {atLeast(profile.role, "manager") ? (
              <a className="btn btn--primary" href="/org/cameras">
                Set up stations
              </a>
            ) : (
              <p className="empty__body">Ask a manager to add the first station.</p>
            )}
          </div>
        ) : null}

        {!loading &&
          groups.map((group) => {
            const lineTotal = group.stations.reduce(
              (sum, station) => sum + totalFor(minutesByStation.get(station.id) ?? []),
              0,
            );
            return (
              <div className="section" key={group.key}>
                <div className="section__head">
                  <h2 className="section__title">{group.name}</h2>
                  <span className="muted">{lineTotal.toLocaleString()} leaves today</span>
                </div>
                <div className="floor-grid floor-grid--wide">
                  {group.stations.map((station) => {
                    const stationMinutes = minutesByStation.get(station.id) ?? [];
                    const session = sessionByStation.get(station.id);
                    const state = sessionState(session);
                    return (
                      <Link
                        className="card card--link stack"
                        to={`/station/${station.id}`}
                        key={station.id}
                      >
                        <div className="row">
                          <strong className="h2">{station.name}</strong>
                          <span className={`pill pill--${state.cls}`}>{state.label}</span>
                          {/* A phone whose clock is out files its leaves under
                              minutes that never happened here, and every figure
                              on this card still looks perfectly normal. */}
                          {isClockDrifting(stationMinutes) ? (
                            <span className="pill pill--warn">camera clock drifting</span>
                          ) : null}
                        </div>
                        <div className="figure">
                          {totalFor(stationMinutes).toLocaleString()}
                          <span className="unit">leaves</span>
                        </div>
                        {session ? <div className="muted">{cameraLine(session)}</div> : null}
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          })}

        {!loading && unstationed.length > 0 ? (
          <div className="section">
            <div className="section__head">
              <h2 className="section__title">Recording with no station</h2>
              <span className="muted">{plural(unstationed.length, "camera")}</span>
            </div>
            <div className="banner banner--warn">
              <span>
                These cameras are recording without a station, so whatever they count belongs to no
                line and appears nowhere above.
              </span>
              {atLeast(profile.role, "owner") ? (
                <a className="btn" href="/org/cameras">
                  Assign them in Cameras
                </a>
              ) : (
                <span>Ask an owner to assign them in Cameras.</span>
              )}
            </div>
            <div className="floor-grid">
              {unstationed.map((session) => {
                const state = sessionState(session);
                return (
                  <div className="card stack" key={session.id}>
                    <div className="row">
                      <strong>{session.device_label ?? "Camera"}</strong>
                      <span className={`pill pill--${state.cls}`}>{state.label}</span>
                    </div>
                    <div className="muted">
                      {functionLabel(session.camera_function)} · since {hhmm(session.started_at)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        <p className="muted">Live video tiles arrive with the Realtime SFU.</p>
      </div>
    </Shell>
  );
}
