import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Shell, { atLeast } from "../components/Shell";
import type { MinuteRow } from "../lib/counts";
import { errorMessage } from "../lib/errorMessage";
import { loadMinutesSince } from "../lib/loadMinutes";
import type { Profile } from "../lib/session";
import { supabase } from "../lib/supabaseClient";

interface StationRow {
  id: string;
  name: string;
  line: string;
}

interface DeviceRow {
  id: string;
  name: string;
  station_id: string | null;
  last_seen_at: string | null;
  revoked_at: string | null;
}

export function health(lastSeen: string | null): { label: string; cls: string } {
  if (!lastSeen) return { label: "never seen", cls: "crit" };
  const minutes = (Date.now() - new Date(lastSeen).getTime()) / 60000;
  if (minutes > 10) return { label: `down ${Math.round(minutes)}m`, cls: "crit" };
  if (minutes > 2) return { label: `stale ${Math.round(minutes)}m`, cls: "warn" };
  return { label: "live", cls: "ok" };
}

const SEVERITY: Record<string, number> = { ok: 0, warn: 1, crit: 2 };

// A station is only as healthy as its worst camera: one dead camera means
// counts are missing however well its neighbour is doing.
function stationHealth(cameras: DeviceRow[]): { label: string; cls: string } {
  let worst: { label: string; cls: string } | null = null;
  for (const camera of cameras) {
    const state = health(camera.last_seen_at);
    if (!worst || (SEVERITY[state.cls] ?? 0) > (SEVERITY[worst.cls] ?? 0)) worst = state;
  }
  return worst ?? { label: "no camera", cls: "idle" };
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

export default function Wall({ profile }: { profile: Profile }) {
  const [stations, setStations] = useState<StationRow[]>([]);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
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
        const [stationResult, deviceResult, minuteResult] = await Promise.all([
          supabase().from("stations").select("id, name, line").order("line").order("name"),
          // Revoked cameras are read too, because the minutes they already wrote
          // still belong to their station: unpairing a phone must not shrink the
          // day's total. They are dropped below, where liveness is shown.
          supabase()
            .from("devices")
            .select("id, name, station_id, last_seen_at, revoked_at")
            .order("name"),
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
        setMinutes(minuteResult.rows);
        setTruncated(minuteResult.truncated);
        setLoading(false);
      } catch (failure) {
        // loadMinutesSince throws where the other two return their error in-band.
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

  const stationOfDevice = new Map<string, string>();
  const camerasByStation = new Map<string, DeviceRow[]>();
  const unassigned: DeviceRow[] = [];
  for (const device of devices) {
    if (device.station_id) stationOfDevice.set(device.id, device.station_id);
    // A revoked camera cannot write, so counting it would hold its station at
    // "down" forever.
    if (device.revoked_at) continue;
    if (!device.station_id) {
      unassigned.push(device);
      continue;
    }
    const list = camerasByStation.get(device.station_id);
    if (list) list.push(device);
    else camerasByStation.set(device.station_id, [device]);
  }

  // The shared loader selects the columns the station screen charts, which do
  // not include the row's own station_id, so a minute is attributed through the
  // camera that wrote it.
  const countByStation = new Map<string, number>();
  for (const row of minutes) {
    const stationId = stationOfDevice.get(row.device_id);
    if (!stationId) continue;
    countByStation.set(stationId, (countByStation.get(stationId) ?? 0) + row.count);
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
                    const cameras = camerasByStation.get(station.id) ?? [];
                    const state = stationHealth(cameras);
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
                        <div className="muted">{plural(cameras.length, "camera")}</div>
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          })}

        {!loading && unassigned.length > 0 ? (
          <div className="section">
            <div className="section__head">
              <h2 className="section__title">Unassigned cameras</h2>
              <span className="muted">{plural(unassigned.length, "camera")}</span>
            </div>
            <div className="banner banner--warn">
              <span>
                These cameras have no station, so whatever they count belongs to no line and appears
                nowhere above.
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
              {unassigned.map((camera) => {
                const state = health(camera.last_seen_at);
                return (
                  <div className="card row" key={camera.id}>
                    <strong>{camera.name}</strong>
                    <span className={`pill pill--${state.cls}`}>{state.label}</span>
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
