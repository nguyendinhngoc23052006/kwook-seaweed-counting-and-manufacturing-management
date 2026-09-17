import { type ReactNode, useCallback, useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import Shell from "../components/Shell";
import { errorMessage } from "../lib/errorMessage";
import { FUNCTIONS, functionLabel } from "../lib/functionsCatalog";
import type { HumanRole, Profile } from "../lib/session";
import { supabase } from "../lib/supabaseClient";
import { type CaptureSession, endSession, loadOpenSessions } from "../services/captureSessions";

interface DeviceRow {
  id: string;
  name: string;
  station_id: string | null;
  camera_function: string;
  revoked_at: string | null;
}

interface StationRow {
  id: string;
  name: string;
  line_id: string | null;
  active: boolean;
}

interface LineRow {
  id: string;
  name: string;
  active: boolean;
}

interface PersonRow {
  id: string;
  display_name: string;
  role: HumanRole;
  created_at: string;
}

const ROLE_LABEL: Record<HumanRole, string> = {
  pending: "No access (pending)",
  viewer: "Viewer",
  supervisor: "Supervisor",
  manager: "Manager",
  owner: "Owner",
};

const APPROVAL_ROLES: HumanRole[] = ["viewer", "supervisor", "manager", "owner"];
const ACCESS_ROLES: HumanRole[] = ["pending", ...APPROVAL_ROLES];

const LADDER_HINT =
  "Viewer sees the wall. Supervisor also sees who else has an account. Manager also edits stations. Owner also pairs cameras and approves people.";

const RECORDING_HINT =
  "End session takes this camera off the line now - the phone stays paired and can start again. ";
const REMOVAL_HINT =
  "Unpair keeps every count this camera ever wrote; Delete camera only works while it has written none.";

// A phone that has said nothing for this long is not proving anything, so
// whatever it has counted since is still sitting in its own queue.
const SILENT_MINUTES = 2;

function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function minutesSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
}

// What the phone has proved, stated as what is missing rather than as a
// reassuring "online": a camera whose heartbeats stopped is still counting on
// its own screen, and those minutes are on the phone, not in the database.
function evidenceLine(session: CaptureSession): string {
  if (!session.last_evidence_at) return "nothing received from the phone yet";
  const silent = minutesSince(session.last_evidence_at);
  if (silent >= SILENT_MINUTES) {
    return `nothing heard for ${silent} min - anything counted since is still queued on the phone`;
  }
  return `last heard ${hhmm(session.last_evidence_at)}`;
}

// The database decides whether a camera may be deleted, so this screen never
// counts rows to guess the answer - it asks, and translates the refusal.
// 23503 is a foreign key still pointing here (its measurements, or the pairing
// code it was claimed with); 42501 is the revoked DELETE privilege from
// migration 20260917090000, which refuses every camera whatever it measured.
function deleteRefusal(failure: { code: string }, name: string): string {
  if (failure.code === "23503") {
    return `${name} has already measured something, so the database refused to delete it - every count, heartbeat and session it produced is kept. Unpair it instead: that cuts the phone off and keeps the history.`;
  }
  if (failure.code === "42501") {
    return `Deleting a camera is switched off in this database, so ${name} cannot be removed this way. Unpair it instead: that cuts the phone off immediately and keeps everything it measured.`;
  }
  return errorMessage(failure);
}

function RoleSelect({
  id,
  label,
  hint,
  value,
  options,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: HumanRole;
  options: HumanRole[];
  disabled: boolean;
  onChange: (role: HumanRole) => void;
}) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="field__input"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as HumanRole)}
      >
        {options.map((role) => (
          <option key={role} value={role}>
            {ROLE_LABEL[role]}
          </option>
        ))}
      </select>
      <span className="field__hint">{hint}</span>
    </div>
  );
}

export default function Admin({ profile }: { profile: Profile }) {
  const formId = useId();
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [stations, setStations] = useState<StationRow[]>([]);
  const [lines, setLines] = useState<LineRow[]>([]);
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [sessions, setSessions] = useState<CaptureSession[]>([]);
  const [drafts, setDrafts] = useState<Record<string, HumanRole>>({});
  const [lineDrafts, setLineDrafts] = useState<Record<string, string>>({});
  const [confirmOwnerId, setConfirmOwnerId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ key: number; text: string } | null>(null);

  const isOwner = profile.role === "owner";

  const refresh = useCallback(async () => {
    try {
      const [d, s, l, p, openSessions] = await Promise.all([
        supabase()
          .from("devices")
          .select("id, name, station_id, camera_function, revoked_at")
          .order("name"),
        supabase().from("stations").select("id, name, line_id, active").order("name"),
        supabase().from("lines").select("id, name, active").order("name"),
        supabase()
          .from("profiles")
          .select("id, display_name, role, created_at")
          .eq("kind", "human")
          .order("display_name"),
        loadOpenSessions(),
      ]);
      const failed = d.error ?? s.error ?? l.error ?? p.error;
      if (failed) {
        setError(errorMessage(failed));
        return;
      }
      setError(null);
      setDevices((d.data as DeviceRow[]) ?? []);
      setStations((s.data as StationRow[]) ?? []);
      setLines((l.data as LineRow[]) ?? []);
      setPeople((p.data as PersonRow[]) ?? []);
      setSessions(openSessions);
    } catch (failure) {
      // loadOpenSessions throws where the four queries return their error in-band.
      setError(errorMessage(failure));
    }
  }, []);

  useEffect(() => {
    if (!isOwner) {
      setLoading(false);
      return;
    }
    void refresh().finally(() => setLoading(false));
  }, [isOwner, refresh]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  function showToast(text: string) {
    setToast({ key: Date.now(), text });
  }

  function roleChoice(person: PersonRow): HumanRole {
    return drafts[person.id] ?? (person.role === "pending" ? "viewer" : person.role);
  }

  // Owner is the whole perimeter - it can approve, demote and unpair anything,
  // including the person granting it - so it never lands on one click.
  async function applyRole(person: PersonRow, role: HumanRole, confirmed = false) {
    if (role === "owner" && person.role !== "owner" && !confirmed) {
      setConfirmOwnerId(person.id);
      return;
    }
    setConfirmOwnerId(null);
    setBusy(person.id);
    const { error: writeError } = await supabase()
      .from("profiles")
      .update({ role })
      .eq("id", person.id);
    if (writeError) {
      setError(errorMessage(writeError));
      setBusy(null);
      return;
    }
    setDrafts((current) => {
      const { [person.id]: _cleared, ...rest } = current;
      return rest;
    });
    await refresh();
    setBusy(null);
    showToast(
      role === "pending"
        ? `${person.display_name} now has no access.`
        : `${person.display_name} can now sign in as ${role}.`,
    );
  }

  // Rejecting is deliberately not a delete: the auth account stays, it simply
  // never leaves 'pending', so it can sign in and see nothing.
  async function rejectPerson(person: PersonRow) {
    if (person.role === "pending") {
      showToast(`${person.display_name} stays pending - no access granted.`);
      return;
    }
    await applyRole(person, "pending");
  }

  // Unpair keeps every row the camera ever wrote - it only cuts the phone off
  // (revoked_at blocks its writes in the database itself), and the database
  // trigger ends any open session, so this only re-reads after.
  async function setRevoked(id: string, revoked: boolean) {
    setBusy(id);
    const { error: writeError } = await supabase()
      .from("devices")
      .update({ revoked_at: revoked ? new Date().toISOString() : null })
      .eq("id", id);
    if (writeError) {
      setError(errorMessage(writeError));
      setBusy(null);
      return;
    }
    await refresh();
    setBusy(null);
    showToast(
      revoked ? "Camera unpaired - everything it measured is kept." : "Camera re-activated.",
    );
  }

  // The other half of "remove a camera" is not a delete at all: this takes it
  // off the line in that instant and leaves the phone paired, free to start a
  // new session.
  async function endOpenSession(device: DeviceRow, session: CaptureSession) {
    setBusy(device.id);
    try {
      await endSession(session.id, "ended_by_owner");
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(null);
      return;
    }
    await refresh();
    setBusy(null);
    showToast(`${device.name} is off the line - it stays paired.`);
  }

  async function deleteCamera(device: DeviceRow) {
    setConfirmDeleteId(null);
    setBusy(device.id);
    const { error: writeError } = await supabase().from("devices").delete().eq("id", device.id);
    if (writeError) {
      setError(deleteRefusal(writeError, device.name));
      setBusy(null);
      return;
    }
    await refresh();
    setBusy(null);
    showToast(`${device.name} deleted - it had measured nothing.`);
  }

  // Placement is the owner's to decide and the camera's to read, so every one
  // of these writes lands on the devices row and the screen re-reads it. The
  // session takes its own snapshot server-side when the camera next starts.
  async function assignStation(device: DeviceRow, stationId: string | null) {
    const target = stations.find((s) => s.id === stationId);
    setBusy(device.id);
    const { error: writeError } = await supabase()
      .from("devices")
      .update({ station_id: stationId })
      .eq("id", device.id);
    if (writeError) {
      setError(errorMessage(writeError));
      setBusy(null);
      return;
    }
    await refresh();
    setBusy(null);
    showToast(
      target
        ? `${device.name} stands at ${target.name}. Its next session starts there.`
        : `${device.name} has no station - it cannot record until you give it one.`,
    );
  }

  async function assignFunction(device: DeviceRow, cameraFunction: string) {
    setBusy(device.id);
    const { error: writeError } = await supabase()
      .from("devices")
      .update({ camera_function: cameraFunction })
      .eq("id", device.id);
    if (writeError) {
      setError(errorMessage(writeError));
      setBusy(null);
      return;
    }
    await refresh();
    setBusy(null);
    showToast(`${device.name} is set to ${functionLabel(cameraFunction)}.`);
  }

  if (!isOwner) {
    return (
      <Shell profile={profile} active="cameras">
        <div className="empty">
          <h2 className="empty__title">Owner access required</h2>
          <p className="empty__body">
            Approving people and pairing cameras is the owner's job, because both hand out access to
            the floor. Ask an owner to raise your role if you need this screen.
          </p>
        </div>
      </Shell>
    );
  }

  const noLines = lines.length === 0;
  const sessionByDevice = new Map(sessions.map((s) => [s.device_id, s]));
  const stationById = new Map(stations.map((s) => [s.id, s]));
  const stationName = (id: string | null) =>
    id ? (stationById.get(id)?.name ?? id) : "no station";
  // A retired line or station stays listed for the camera already on it, so an
  // existing assignment is never silently dropped by the filter.
  const lineChoices = (current: string) => lines.filter((l) => l.active || l.id === current);
  const stationChoices = (lineId: string, current: string | null) =>
    stations.filter((s) => s.line_id === lineId && (s.active || s.id === current));
  const chosenLine = (device: DeviceRow) =>
    lineDrafts[device.id] ??
    (device.station_id ? (stationById.get(device.station_id)?.line_id ?? "") : "");

  function assignmentHint(device: DeviceRow, lineId: string): ReactNode {
    if (noLines) {
      return (
        <>
          <Link to="/stations">Create a station</Link> first - a camera with nowhere to stand never
          reaches the wall.
        </>
      );
    }
    const placed = device.station_id ? stationById.get(device.station_id) : undefined;
    if (placed && placed.line_id !== lineId) {
      return `Still standing at ${placed.name} until you pick a station on this line.`;
    }
    if (!placed) return "No station, so this camera cannot start recording.";
    return "The camera reads this placement. It never chooses it.";
  }

  const functionChoices = (current: string) => {
    const catalog = FUNCTIONS.map((f) => f.value as string);
    return catalog.includes(current) ? catalog : [current, ...catalog];
  };

  const pending = people.filter((p) => p.role === "pending");
  const approved = people.filter((p) => p.role !== "pending");

  function confirmOwnerBanner(person: PersonRow) {
    return (
      <div className="banner banner--warn" role="alert">
        <span>
          An owner can approve people, change every role including yours, and unpair every camera.
          Make {person.display_name} an owner?
        </span>
        <button
          type="button"
          className="btn btn--danger"
          disabled={busy === person.id}
          onClick={() => applyRole(person, "owner", true)}
        >
          Yes, make them an owner
        </button>
        <button type="button" className="btn btn--ghost" onClick={() => setConfirmOwnerId(null)}>
          Cancel
        </button>
      </div>
    );
  }

  function confirmDeleteBanner(device: DeviceRow) {
    return (
      <div className="banner banner--warn" role="alert">
        <span>
          Delete removes {device.name} from the database entirely. It is for a phone paired by
          mistake: once a camera has counted anything the database refuses, and its measurements are
          kept either way. Unpair is the normal way to remove a camera.
        </span>
        <button
          type="button"
          className="btn btn--danger"
          disabled={busy === device.id}
          onClick={() => deleteCamera(device)}
        >
          Yes, delete this camera
        </button>
        <button type="button" className="btn btn--ghost" onClick={() => setConfirmDeleteId(null)}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <Shell profile={profile} active="cameras">
      <div className="stack">
        <div className="section__head">
          <h1 className="h1">People and cameras</h1>
          <span className="muted">
            {approved.length} with access · {devices.length} camera
            {devices.length === 1 ? "" : "s"}
          </span>
        </div>

        {error ? (
          <div className="banner banner--crit" role="alert">
            {error}
          </div>
        ) : null}

        <div className="section">
          <div className="section__head">
            <h2 className="section__title">People waiting for approval</h2>
            {pending.length > 0 ? <span className="muted">{pending.length} waiting</span> : null}
          </div>

          {loading ? (
            <div className="card">
              <p className="skeleton">Loading the approval queue</p>
              <p className="skeleton">Loading the approval queue</p>
            </div>
          ) : null}

          {!loading && pending.length === 0 ? (
            <div className="empty">
              <h2 className="empty__title">Nobody waiting</h2>
              <p className="empty__body">
                Anyone can sign up, and every new account lands here with no access at all until you
                give it a role.
              </p>
            </div>
          ) : null}

          {!loading && pending.length > 0 ? (
            <div className="grid grid--wide">
              {pending.map((person) => (
                <div className="card" key={person.id}>
                  <div className="stack">
                    <div className="row">
                      <strong>{person.display_name}</strong>
                      <span className="pill pill--warn">waiting</span>
                    </div>
                    <span className="muted">
                      Signed up {new Date(person.created_at).toLocaleDateString()}
                    </span>
                    <RoleSelect
                      id={`${formId}-pending-${person.id}`}
                      label="Approve as"
                      hint={LADDER_HINT}
                      value={roleChoice(person)}
                      options={APPROVAL_ROLES}
                      disabled={busy === person.id}
                      onChange={(role) => setDrafts((c) => ({ ...c, [person.id]: role }))}
                    />
                    {confirmOwnerId === person.id ? (
                      confirmOwnerBanner(person)
                    ) : (
                      <div className="row">
                        <button
                          type="button"
                          className="btn btn--primary"
                          disabled={busy === person.id}
                          onClick={() => applyRole(person, roleChoice(person))}
                        >
                          {busy === person.id ? <span className="spinner" /> : null}
                          Approve
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost"
                          disabled={busy === person.id}
                          onClick={() => rejectPerson(person)}
                        >
                          Reject
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="section">
          <div className="section__head">
            <h2 className="section__title">People</h2>
            <span className="muted">Everyone who can sign in</span>
          </div>

          {loading ? (
            <div className="card">
              <p className="skeleton">Loading the roster</p>
              <p className="skeleton">Loading the roster</p>
            </div>
          ) : null}

          {!loading && approved.length === 0 ? (
            <div className="empty">
              <h2 className="empty__title">Nobody has access yet</h2>
              <p className="empty__body">
                Approved accounts show up here, and you can change or remove a role at any time.
              </p>
            </div>
          ) : null}

          {!loading && approved.length > 0 ? (
            <div className="grid grid--wide">
              {approved.map((person) => {
                const isSelf = person.id === profile.id;
                const choice = roleChoice(person);
                return (
                  <div className="card" key={person.id}>
                    <div className="stack">
                      <div className="row">
                        <strong>{person.display_name}</strong>
                        <span className="pill pill--ok">{ROLE_LABEL[person.role]}</span>
                      </div>
                      <RoleSelect
                        id={`${formId}-person-${person.id}`}
                        label="Role"
                        hint={
                          isSelf
                            ? "This is you. An owner cannot change their own role: demote yourself and nobody is left who can approve anyone, pair a camera, or promote you back."
                            : LADDER_HINT
                        }
                        value={choice}
                        options={ACCESS_ROLES}
                        disabled={isSelf || busy === person.id}
                        onChange={(role) => setDrafts((c) => ({ ...c, [person.id]: role }))}
                      />
                      {confirmOwnerId === person.id ? (
                        confirmOwnerBanner(person)
                      ) : (
                        <div className="row">
                          <button
                            type="button"
                            className="btn btn--primary"
                            disabled={isSelf || busy === person.id || choice === person.role}
                            onClick={() => applyRole(person, choice)}
                          >
                            {busy === person.id ? <span className="spinner" /> : null}
                            Save role
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>

        <div className="section">
          <div className="section__head">
            <h2 className="section__title">Cameras</h2>
            <Link className="btn btn--primary" to="/scan">
              Pair a camera
            </Link>
          </div>

          <div className="banner banner--info">
            Open this site on the camera phone, tap "Use this device as a camera", then scan the QR
            it shows with "Pair a camera". You decide where every camera stands and what it does -
            the phone only reads its assignment.
          </div>

          {loading ? (
            <div className="card">
              <p className="skeleton">Loading cameras</p>
              <p className="skeleton">Loading cameras</p>
            </div>
          ) : null}

          {!loading && devices.length === 0 ? (
            <div className="empty">
              <h2 className="empty__title">No cameras paired yet</h2>
              <p className="empty__body">
                A camera is any phone showing a pairing QR. It never gets a password: you claim it
                here, and it counts only for the station you give it.
              </p>
            </div>
          ) : null}

          {!loading && devices.length > 0 ? (
            <div className="card card--flush">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>On the line now</th>
                    <th>Assignment</th>
                    <th>Status</th>
                    <th>
                      <span className="sr-only">Action</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {devices.map((d) => {
                    const session = sessionByDevice.get(d.id);
                    const lineId = chosenLine(d);
                    const placedOnChosenLine =
                      d.station_id !== null && stationById.get(d.station_id)?.line_id === lineId;
                    return (
                      <tr key={d.id}>
                        <td data-label="Name">{d.name}</td>
                        <td data-label="On the line now">
                          {session ? (
                            <div className="field">
                              <span className="pill pill--ok">running</span>
                              <span className="field__hint">
                                {session.station_name ?? stationName(session.station_id)} · since{" "}
                                {hhmm(session.started_at)}
                              </span>
                              <span className="field__hint">{evidenceLine(session)}</span>
                            </div>
                          ) : (
                            <span className="pill pill--idle">idle</span>
                          )}
                        </td>
                        <td data-label="Assignment">
                          <div className="stack">
                            <div className="field">
                              <label className="field__label" htmlFor={`${formId}-line-${d.id}`}>
                                Line
                              </label>
                              <select
                                id={`${formId}-line-${d.id}`}
                                className="field__input"
                                value={lineId}
                                disabled={noLines || busy === d.id}
                                onChange={(e) =>
                                  setLineDrafts((c) => ({ ...c, [d.id]: e.target.value }))
                                }
                              >
                                <option value="">— choose a line —</option>
                                {lineChoices(lineId).map((l) => (
                                  <option key={l.id} value={l.id}>
                                    {l.active ? l.name : `${l.name} (inactive)`}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div className="field">
                              <label className="field__label" htmlFor={`${formId}-station-${d.id}`}>
                                Station
                              </label>
                              <select
                                id={`${formId}-station-${d.id}`}
                                className="field__input"
                                value={placedOnChosenLine ? (d.station_id ?? "") : ""}
                                disabled={!lineId || busy === d.id}
                                onChange={(e) => assignStation(d, e.target.value || null)}
                              >
                                <option value="">— no station —</option>
                                {stationChoices(lineId, d.station_id).map((s) => (
                                  <option key={s.id} value={s.id}>
                                    {s.active ? s.name : `${s.name} (inactive)`}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div className="field">
                              <label
                                className="field__label"
                                htmlFor={`${formId}-function-${d.id}`}
                              >
                                Job
                              </label>
                              <select
                                id={`${formId}-function-${d.id}`}
                                className="field__input"
                                value={d.camera_function}
                                disabled={busy === d.id}
                                onChange={(e) => assignFunction(d, e.target.value)}
                              >
                                {functionChoices(d.camera_function).map((value) => (
                                  <option key={value} value={value}>
                                    {functionLabel(value)}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <span className="field__hint">{assignmentHint(d, lineId)}</span>
                          </div>
                        </td>
                        <td data-label="Status">
                          <span className={d.revoked_at ? "pill pill--crit" : "pill pill--ok"}>
                            {d.revoked_at ? "unpaired" : "paired"}
                          </span>
                        </td>
                        <td>
                          {confirmDeleteId === d.id ? (
                            confirmDeleteBanner(d)
                          ) : (
                            <div className="field">
                              <div className="row">
                                {session ? (
                                  <button
                                    type="button"
                                    className="btn btn--ghost"
                                    disabled={busy === d.id}
                                    onClick={() => endOpenSession(d, session)}
                                  >
                                    End session
                                  </button>
                                ) : null}
                                <button
                                  type="button"
                                  className="btn"
                                  disabled={busy === d.id}
                                  onClick={() => setRevoked(d.id, !d.revoked_at)}
                                >
                                  {d.revoked_at ? "Re-activate" : "Unpair"}
                                </button>
                                <button
                                  type="button"
                                  className="btn btn--danger"
                                  disabled={busy === d.id}
                                  onClick={() => setConfirmDeleteId(d.id)}
                                >
                                  Delete camera
                                </button>
                              </div>
                              <span className="field__hint">
                                {session ? `${RECORDING_HINT}${REMOVAL_HINT}` : REMOVAL_HINT}
                              </span>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </div>

      <div className="toast-host" aria-live="polite">
        {toast ? (
          <div className="toast toast--ok" key={toast.key}>
            {toast.text}
          </div>
        ) : null}
      </div>
    </Shell>
  );
}
