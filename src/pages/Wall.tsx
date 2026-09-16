import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Shell, { atLeast } from "../components/Shell";
import type { MinuteRow } from "../lib/counts";
import { errorMessage } from "../lib/errorMessage";
import { functionLabel } from "../lib/functionsCatalog";
import { loadMinutesSince } from "../lib/loadMinutes";
import type { Profile } from "../lib/session";
import { supabase } from "../lib/supabaseClient";
import { type CaptureSession, loadOpenSessions } from "../services/captureSessions";

interface StationRow {
  id: string;
  name: string;
  line: string;
}

interface DeviceRow {
  id: string;
  name: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

// A camera on the line is an open session plus the phone holding it. Nothing
// here reads devices.role or devices.station_id for what is happening now -
// those survive only as the defaults the next session is pre-filled with.
interface ActiveCamera {
  session: CaptureSession;
  device: DeviceRow;
}

export function health(lastSeen: string | null): { label: string; cls: string } {
  if (!lastSeen) return { label: "never seen", cls: "crit" };
  const minutes = (Date.now() - new Date(lastSeen).getTime()) / 60000;
  if (minutes > 10) return { label: `down ${Math.round(minutes)}m`, cls: "crit" };
  if (minutes > 2) return { label: `stale ${Math.round(minutes)}m`, cls: "warn" };
  return { label: "live", cls: "ok" };
}

const SEVERITY: Record<string, number> = { ok: 0, warn: 1, crit: 2 };

// A station is only as healthy as its worst recording camera: one dead camera
// means counts are missing however well its neighbour is doing.
//
// With no open session the station is OFF the line in that instant - the end of
// a shift, not a fault, so it never ages into "stale". The thresholds keep their
// old meaning for the sessions that ARE open, where they now say something
// sharper: this camera claims to be recording and is not reporting.
function stationState(cameras: ActiveCamera[]): { label: string; cls: string } {
  let worst: { label: string; cls: string } | null = null;
  for (const camera of cameras) {
    const state = health(camera.device.last_seen_at);
    if (!worst || (SEVERITY[state.cls] ?? 0) > (SEVERITY[worst.cls] ?? 0)) worst = state;
  }
  return worst ?? { label: "off", cls: "idle" };
}

function groupByLine(rows: StationRow[]): [string, StationRow[]][] {
  const byLine = new Map<string, StationRow[]>();
  for (const row of rows) {
    const list = byLine.get(row.line);
    if (list) list.push(row);
    else byLine.set(row.line, [row]);
  }
  return [...byLine];
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function Wall({ profile }: { profile: Profile }) {
  const [stations, setStations] = useState<StationRow[]>([]);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
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
        const [stationResult, deviceResult, openSessions, minuteResult] = await Promise.all([
          supabase().from("stations").select("id, name, line").order("line").order("name"),
          // Revoked cameras are read too, because the minutes they already wrote
          // still belong to their station: unpairing a phone must not shrink the
          // day's total. They are dropped below, where liveness is shown.
          supabase().from("devices").select("id, name, last_seen_at, revoked_at").order("name"),
          loadOpenSessions(),
          loadMinutesSince(dayStart.toISOString()),
        ]);
        if (cancelled) return;

        const failure = stationResult.error ?? deviceResult.error;
        if (failure) {
          setError(errorMessage(failure));
          setLoading(false);
          return;
        }
        setError(null);
        setStations((stationResult.data as StationRow[]) ?? []);
        setDevices((deviceResult.data as DeviceRow[]) ?? []);
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

  const liveDevices = new Map<string, DeviceRow>();
  for (const device of devices) {
    // A revoked camera cannot write, so counting it would hold its station at
    // "down" forever. The revoke also closes its sessions in the database, so
    // dropping it here drops whatever open row was still in flight.
    if (device.revoked_at) continue;
    liveDevices.set(device.id, device);
  }

  const activeByStation = new Map<string, ActiveCamera[]>();
  const unstationed: ActiveCamera[] = [];
  for (const session of sessions) {
    const device = liveDevices.get(session.device_id);
    if (!device) continue;
    const camera = { session, device };
    if (!session.station_id) {
      unstationed.push(camera);
      continue;
    }
    const list = activeByStation.get(session.station_id);
    if (list) list.push(camera);
    else activeByStation.set(session.station_id, [camera]);
  }

  // Today's totals are history, not liveness: every minute belongs to the
  // station its own session was pointed at, which is what the station screen
  // filters on. Attributing through the camera's current default would move a
  // whole morning to another line the moment an owner changed it.
  const countByStation = new Map<string, number>();
  for (const row of minutes) {
    if (!row.station_id) continue;
    countByStation.set(row.station_id, (countByStation.get(row.station_id) ?? 0) + row.count);
  }

  const lines = groupByLine(stations);

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
            <div className="grid grid--wide">
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
              <Link className="btn btn--primary" to="/stations">
                Set up stations
              </Link>
            ) : (
              <p className="empty__body">Ask a manager to add the first station.</p>
            )}
          </div>
        ) : null}

        {!loading &&
          lines.map(([line, list]) => {
            const lineTotal = list.reduce((sum, s) => sum + (countByStation.get(s.id) ?? 0), 0);
            return (
              <div className="section" key={line}>
                <div className="section__head">
                  <h2 className="section__title">{line}</h2>
                  <span className="muted">{lineTotal.toLocaleString()} leaves today</span>
                </div>
                <div className="grid grid--wide">
                  {list.map((station) => {
                    const running = activeByStation.get(station.id) ?? [];
                    const state = stationState(running);
                    return (
                      <Link
                        className="card card--link stack"
                        to={`/station/${station.id}`}
                        key={station.id}
                      >
                        <div className="row">
                          <strong className="h2">{station.name}</strong>
                          <span className={`pill pill--${state.cls}`}>{state.label}</span>
                        </div>
                        <div className="figure">
                          {(countByStation.get(station.id) ?? 0).toLocaleString()}
                          <span className="unit">leaves</span>
                        </div>
                        {running.map(({ session, device }) => (
                          <div className="muted" key={session.id}>
                            {device.name} · {functionLabel(session.camera_function)} · since{" "}
                            {hhmm(session.started_at)}
                          </div>
                        ))}
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
                <Link className="btn" to="/admin">
                  Assign them in Cameras
                </Link>
              ) : (
                <span>Ask an owner to assign them in Cameras.</span>
              )}
            </div>
            <div className="grid">
              {unstationed.map(({ session, device }) => {
                const state = health(device.last_seen_at);
                return (
                  <div className="card stack" key={session.id}>
                    <div className="row">
                      <strong>{device.name}</strong>
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
