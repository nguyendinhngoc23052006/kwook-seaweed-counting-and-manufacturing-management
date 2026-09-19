import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import Shell, { atLeast } from "../components/Shell";
import {
  clockDriftSeconds,
  coverage,
  isClockDrifting,
  type MinuteRow,
  perMinuteSeries,
  ratePerHour,
  totalFor,
} from "../lib/counts";
import { errorMessage } from "../lib/errorMessage";
import { functionLabel } from "../lib/functionsCatalog";
import { loadMinutesSince } from "../lib/loadMinutes";
import type { Profile } from "../lib/session";
import { kindLabel } from "../lib/stationKinds";
import { supabase } from "../lib/supabaseClient";
import { type CaptureSession, loadOpenSessions } from "../services/captureSessions";

const MINUTE_MS = 60_000;
const WINDOW_MINUTES = 60;
const REFRESH_MS = 15_000;
const STRIP_PX = 56;

interface StationRow {
  id: string;
  name: string;
  line_id: string | null;
  kind: string;
  active: boolean;
}

interface LineRow {
  id: string;
  name: string;
}

interface Snapshot {
  station: StationRow | null;
  // Resolved from the lines table, not from a text column on the station: a
  // line is a row now (migration 20260917091000) and two spellings of one name
  // are no longer two lines.
  lineName: string | null;
  // At most one, and the database says so: capture_sessions_one_open_per_station
  // is a unique index, so two phones can no longer both count this station.
  session: CaptureSession | null;
  hour: MinuteRow[];
  today: MinuteRow[];
  truncated: boolean;
  fromIso: string;
  toIso: string;
}

// The same reading the wall takes, so the two screens never disagree about one
// station: the open session is what this station is doing, and its own evidence
// (last_evidence_at, advanced by every heartbeat) is how alive it is. No open
// session is "off" - a shift that ended, not a fault.
function sessionState(session: CaptureSession | null): { label: string; cls: string } {
  if (!session) return { label: "off", cls: "pill--idle" };
  const evidence = session.last_evidence_at ?? session.started_at;
  const minutes = (Date.now() - new Date(evidence).getTime()) / MINUTE_MS;
  if (minutes > 10) return { label: `silent ${Math.round(minutes)}m`, cls: "pill--crit" };
  if (minutes > 2) return { label: `quiet ${Math.round(minutes)}m`, cls: "pill--warn" };
  return { label: "running", cls: "pill--ok" };
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
        const [station, lines, openSessions, hour, today] = await Promise.all([
          client
            .from("stations")
            .select("id, name, line_id, kind, active")
            .eq("id", stationId)
            .maybeSingle(),
          client.from("lines").select("id, name"),
          // No devices read: the session carries the phone's label and its own
          // evidence, and revoking a phone closes its sessions in the database
          // (migration 20260916170000), so an open session is a live camera.
          loadOpenSessions(),
          loadMinutesSince(fromIso, stationId),
          loadMinutesSince(midnight.toISOString(), stationId),
        ]);
        if (cancelled) return;

        const failed = station.error ?? lines.error;
        if (failed) {
          // Keep the last good snapshot on screen; a blank wall is worse than a
          // stale one, and the banner says which it is.
          setError(errorMessage(failed));
          return;
        }
        setError(null);
        const row = (station.data as StationRow | null) ?? null;
        const lineRows = (lines.data as LineRow[]) ?? [];
        setSnap({
          station: row,
          lineName: lineRows.find((line) => line.id === row?.line_id)?.name ?? null,
          session: openSessions.find((session) => session.station_id === stationId) ?? null,
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
              This station does not exist, or you do not have access to it.
            </p>
            <Link className="btn btn--primary" to="/wall">
              Back to the wall
            </Link>
          </div>
        </div>
      </Shell>
    );
  }

  const { station, lineName, session, hour, today, truncated, fromIso, toIso } = snap;
  const series = perMinuteSeries(hour, fromIso, toIso);
  const peak = series.reduce((max, point) => Math.max(max, point.count), 0);
  const covered = coverage(hour, WINDOW_MINUTES);
  const reported = Math.round(covered * WINDOW_MINUTES);
  const state = sessionState(session);
  const drifting = isClockDrifting(hour);
  const driftMinutes = Math.round(Math.abs(clockDriftSeconds(hour) ?? 0) / 60);

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
            <p className="muted">{lineName ?? "No line yet"}</p>
          </div>
          <div className="row">
            <span className="pill pill--idle">{kindLabel(station.kind)}</span>
            <span className={`pill ${state.cls}`}>{state.label}</span>
          </div>
        </div>

        {!session ? (
          <div className="empty">
            <h2 className="empty__title">No camera is recording here</h2>
            <p className="empty__body">
              A camera belongs to this station only while a session is running, so signing one off
              takes it off the line at once. The figures below are what earlier sessions left
              behind.
            </p>
            <Link className="btn btn--primary" to="/admin">
              Open Cameras
            </Link>
          </div>
        ) : (
          <div className="row">
            <span className={`pill ${state.cls}`}>
              {session.device_label ?? "Camera"} · {functionLabel(session.camera_function)} · since{" "}
              {hhmm(session.started_at)} · {state.label}
            </span>
          </div>
        )}

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
            <span className="muted">The figures above cover only the minutes that reported.</span>
          ) : null}
          {/* A phone whose clock is out writes perfectly well-formed rows
              against minutes that never happened here, so the strip below shows
              a hole and a spike where one steady shift actually ran. Nothing
              else on this page reveals it. */}
          {drifting ? (
            <>
              <span className="pill pill--warn">camera clock drifting</span>
              <span className="muted">
                Minutes are arriving about {driftMinutes} minute{driftMinutes === 1 ? "" : "s"} out,
                so they are filed against the wrong time.
              </span>
            </>
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
      </div>
    </Shell>
  );
}
