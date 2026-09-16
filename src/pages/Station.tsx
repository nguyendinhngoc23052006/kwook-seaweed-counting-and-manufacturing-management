import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import Shell, { atLeast } from "../components/Shell";
import { coverage, type MinuteRow, perMinuteSeries, ratePerHour, totalFor } from "../lib/counts";
import { errorMessage } from "../lib/errorMessage";
import { loadMinutesSince } from "../lib/loadMinutes";
import type { Profile } from "../lib/session";
import { kindLabel } from "../lib/stationKinds";
import { supabase } from "../lib/supabaseClient";

const MINUTE_MS = 60_000;
const WINDOW_MINUTES = 60;
const REFRESH_MS = 15_000;
const STRIP_PX = 56;

interface StationRow {
  id: string;
  name: string;
  line: string;
  kind: string;
  active: boolean;
}

interface CameraRow {
  id: string;
  name: string;
  last_seen_at: string | null;
}

interface Snapshot {
  station: StationRow | null;
  cameras: CameraRow[];
  hour: MinuteRow[];
  today: MinuteRow[];
  truncated: boolean;
  fromIso: string;
  toIso: string;
}

// Same thresholds the wall uses: over 10 minutes silent is down, over 2 is
// stale.
function health(lastSeen: number | null): { label: string; cls: string } {
  if (lastSeen === null) return { label: "never seen", cls: "pill--crit" };
  const minutes = (Date.now() - lastSeen) / MINUTE_MS;
  if (minutes > 10) return { label: `down ${Math.round(minutes)}m`, cls: "pill--crit" };
  if (minutes > 2) return { label: `stale ${Math.round(minutes)}m`, cls: "pill--warn" };
  return { label: "live", cls: "pill--ok" };
}

function seenAt(camera: CameraRow): number | null {
  if (!camera.last_seen_at) return null;
  const t = new Date(camera.last_seen_at).getTime();
  return Number.isNaN(t) ? null : t;
}

const SEVERITY: Record<string, number> = { "pill--ok": 0, "pill--warn": 1, "pill--crit": 2 };

// A station is only as healthy as its worst camera: one dead camera means
// counts are missing however well its neighbour is doing. The wall ranks them
// the same way, so the two screens never disagree about one station.
function worstHealth(cameras: CameraRow[]): { label: string; cls: string } {
  let worst: { label: string; cls: string } | null = null;
  for (const camera of cameras) {
    const state = health(seenAt(camera));
    if (!worst || (SEVERITY[state.cls] ?? 0) > (SEVERITY[worst.cls] ?? 0)) worst = state;
  }
  return worst ?? { label: "no camera", cls: "pill--idle" };
}

function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function Station({ profile }: { profile: Profile }) {
  const { id } = useParams();
  const stationId = id ?? "";
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!stationId) return;
    let cancelled = false;

    const load = async () => {
      const to = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
      const from = to - (WINDOW_MINUTES - 1) * MINUTE_MS;
      const fromIso = new Date(from).toISOString();
      const toIso = new Date(to).toISOString();
      // "Today" is the floor's today, not UTC's: a shift that started this
      // morning must not reset halfway through it.
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);

      const client = supabase();
      try {
        const [station, cameras, hour, today] = await Promise.all([
          client
            .from("stations")
            .select("id, name, line, kind, active")
            .eq("id", stationId)
            .maybeSingle(),
          // A revoked camera cannot write, so its last heartbeat would hold a
          // dead station at "live" forever. The wall filters them the same way.
          client
            .from("devices")
            .select("id, name, last_seen_at")
            .eq("station_id", stationId)
            .is("revoked_at", null)
            .order("name"),
          loadMinutesSince(fromIso, stationId),
          loadMinutesSince(midnight.toISOString(), stationId),
        ]);
        if (cancelled) return;

        const failed = station.error ?? cameras.error;
        if (failed) {
          // Keep the last good snapshot on screen; a blank wall is worse than a
          // stale one, and the banner says which it is.
          setError(errorMessage(failed));
          return;
        }
        setError(null);
        setSnap({
          station: (station.data as StationRow | null) ?? null,
          cameras: (cameras.data as CameraRow[]) ?? [],
          hour: hour.rows,
          today: today.rows,
          truncated: hour.truncated || today.truncated,
          fromIso,
          toIso,
        });
      } catch (e: unknown) {
        if (cancelled) return;
        setError(errorMessage(e));
      }
    };

    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [stationId]);

  // Devices are given the "viewer" role when they are paired, so rank alone
  // would let a camera phone open any station's totals. The kind check is the
  // gate; the database enforces the same thing with is_human_at_least.
  if (profile.kind !== "human" || !atLeast(profile.role, "viewer")) {
    return (
      <Shell profile={profile} active="wall">
        <div className="empty">
          <h1 className="empty__title">Not available on this device</h1>
          <p className="empty__body">Station figures are for signed-in people, viewer and above.</p>
        </div>
      </Shell>
    );
  }

  const banner = error ? (
    <div className="banner banner--crit" role="alert">
      {error}
    </div>
  ) : null;

  if (!snap) {
    return (
      <Shell profile={profile} active="wall">
        <div className="stack">
          {banner}
          <div className="skeleton h1">Loading station</div>
          <div className="grid">
            <div className="card">
              <div className="stack">
                <div className="skeleton">Loading</div>
                <div className="skeleton figure">0</div>
              </div>
            </div>
            <div className="card">
              <div className="stack">
                <div className="skeleton">Loading</div>
                <div className="skeleton figure">0</div>
              </div>
            </div>
            <div className="card">
              <div className="stack">
                <div className="skeleton">Loading</div>
                <div className="skeleton figure">0</div>
              </div>
            </div>
          </div>
        </div>
      </Shell>
    );
  }

  if (!snap.station) {
    return (
      <Shell profile={profile} active="wall">
        <div className="stack">
          {banner}
          <div className="empty">
            <h1 className="empty__title">No such station</h1>
            <p className="empty__body">
              This station does not exist, or it belongs to another tenant.
            </p>
            <Link className="btn btn--primary" to="/wall">
              Back to the wall
            </Link>
          </div>
        </div>
      </Shell>
    );
  }

  const { station, cameras, hour, today, truncated, fromIso, toIso } = snap;
  const series = perMinuteSeries(hour, fromIso, toIso);
  const peak = series.reduce((max, point) => Math.max(max, point.count), 0);
  const covered = coverage(hour, WINDOW_MINUTES);
  const reported = Math.round(covered * WINDOW_MINUTES);
  const stationHealth = worstHealth(cameras);

  return (
    <Shell profile={profile} active="wall">
      <div className="stack">
        {banner}

        {truncated ? (
          <div className="banner banner--warn" role="alert">
            Too many minutes to read in one go, so the figures below are part of the day, not all of
            it. The real totals are higher.
          </div>
        ) : null}

        <div className="section__head">
          <div>
            <h1 className="h1">{station.name}</h1>
            <p className="muted">Line {station.line}</p>
          </div>
          <div className="row">
            <span className="pill pill--idle">{kindLabel(station.kind)}</span>
            <span className={`pill ${stationHealth.cls}`}>{stationHealth.label}</span>
          </div>
        </div>

        {cameras.length === 0 ? (
          <div className="empty">
            <h2 className="empty__title">No cameras on this station yet</h2>
            <p className="empty__body">
              Nothing is counting here. Pair a camera phone and assign it to this station, then the
              figures start filling in on their own.
            </p>
            <Link className="btn btn--primary" to="/admin">
              Pair a camera
            </Link>
          </div>
        ) : (
          <>
            <div className="grid">
              <div className="card">
                <div className="stack">
                  <div className="label">Today</div>
                  <div className="figure figure--lg">
                    {totalFor(today).toLocaleString()}
                    <span className="unit">leaves</span>
                  </div>
                </div>
              </div>
              <div className="card">
                <div className="stack">
                  <div className="label">Last hour</div>
                  <div className="figure">
                    {totalFor(hour).toLocaleString()}
                    <span className="unit">leaves</span>
                  </div>
                </div>
              </div>
              <div className="card">
                <div className="stack">
                  <div className="label">Per hour now</div>
                  <div className="figure">
                    {Math.round(ratePerHour(hour)).toLocaleString()}
                    <span className="unit">/h</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="row">
              <span className={covered < 0.9 ? "pill pill--warn" : "pill pill--idle"}>
                Reported {reported} of the last {WINDOW_MINUTES} minutes.
              </span>
              {covered < 0.9 ? (
                <span className="muted">
                  The figures above cover only the minutes that reported.
                </span>
              ) : null}
            </div>

            <div className="section">
              <div className="section__head">
                <h2 className="section__title">Last {WINDOW_MINUTES} minutes</h2>
                <span className="muted">
                  {hhmm(fromIso)} - {hhmm(toIso)} · peak {peak.toLocaleString()}/min
                </span>
              </div>
              {/* Every bar's geometry is computed from the data, which is the one
                  thing a class cannot carry. Colour still comes from the class:
                  the fill is currentColor. */}
              <div className="card card--flush">
                {series.map((point) => (
                  <div
                    key={point.minute}
                    className={point.count > 0 ? "ok" : "muted"}
                    title={`${hhmm(point.minute)} · ${point.count}`}
                    style={{
                      display: "inline-block",
                      verticalAlign: "bottom",
                      background: "currentColor",
                      width: `${100 / series.length}%`,
                      height:
                        peak > 0 && point.count > 0
                          ? `${Math.max(3, Math.round((point.count / peak) * STRIP_PX))}px`
                          : "2px",
                    }}
                  />
                ))}
              </div>
            </div>

            <div className="section">
              <h2 className="section__title">Cameras</h2>
              <div className="row">
                {cameras.map((camera) => {
                  const cameraHealth = health(seenAt(camera));
                  return (
                    <span className={`pill ${cameraHealth.cls}`} key={camera.id}>
                      {camera.name} · {cameraHealth.label}
                    </span>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>
    </Shell>
  );
}
