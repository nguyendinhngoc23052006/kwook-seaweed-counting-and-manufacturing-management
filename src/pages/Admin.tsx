import { useCallback, useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import Shell from "../components/Shell";
import { errorMessage } from "../lib/errorMessage";
import { functionLabel } from "../lib/functionsCatalog";
import type { HumanRole, Profile } from "../lib/session";
import { supabase } from "../lib/supabaseClient";

interface DeviceRow {
  id: string;
  name: string;
  role: string;
  station_id: string | null;
  revoked_at: string | null;
}

interface StationRow {
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
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [drafts, setDrafts] = useState<Record<string, HumanRole>>({});
  const [confirmOwnerId, setConfirmOwnerId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ key: number; text: string } | null>(null);

  const isOwner = profile.role === "owner";

  const refresh = useCallback(async () => {
    const [d, s, p] = await Promise.all([
      supabase().from("devices").select("id, name, role, station_id, revoked_at").order("name"),
      supabase().from("stations").select("id, name, active").order("name"),
      supabase()
        .from("profiles")
        .select("id, display_name, role, created_at")
        .eq("kind", "human")
        .order("display_name"),
    ]);
    const failed = d.error ?? s.error ?? p.error;
    if (failed) {
      setError(errorMessage(failed));
      return;
    }
    setError(null);
    setDevices((d.data as DeviceRow[]) ?? []);
    setStations((s.data as StationRow[]) ?? []);
    setPeople((p.data as PersonRow[]) ?? []);
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
  // (revoked_at blocks its writes in the database itself). There is
  // deliberately NO delete: deleting a device would cascade into its history.
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
    showToast(revoked ? "Camera unpaired." : "Camera re-activated.");
  }

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
        ? `${device.name} now counts for ${target.name}.`
        : `${device.name} has no station - its counts stay off the wall.`,
    );
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

  const noStations = stations.length === 0;
  // A retired station stays listed for the camera already on it, so an existing
  // assignment is never silently dropped by the filter.
  const stationChoices = (current: string | null) =>
    stations.filter((s) => s.active || s.id === current);
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
            it shows with "Pair a camera". Unpairing keeps all of a camera's data.
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
                    <th>Function</th>
                    <th>Station</th>
                    <th>Status</th>
                    <th>
                      <span className="sr-only">Action</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {devices.map((d) => (
                    <tr key={d.id}>
                      <td data-label="Name">{d.name}</td>
                      <td data-label="Function">{functionLabel(d.role)}</td>
                      <td data-label="Station">
                        <div className="field">
                          <select
                            className="field__input"
                            aria-label={`Station for ${d.name}`}
                            value={d.station_id ?? ""}
                            disabled={noStations || busy === d.id}
                            onChange={(e) => assignStation(d, e.target.value || null)}
                          >
                            <option value="">— no station —</option>
                            {stationChoices(d.station_id).map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.active ? s.name : `${s.name} (inactive)`}
                              </option>
                            ))}
                          </select>
                          {noStations ? (
                            <span className="field__hint">
                              <Link to="/stations">Create a station</Link> first - a camera with no
                              station never reaches the wall.
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td data-label="Status">
                        <span className={d.revoked_at ? "pill pill--crit" : "pill pill--ok"}>
                          {d.revoked_at ? "unpaired" : "paired"}
                        </span>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn"
                          disabled={busy === d.id}
                          onClick={() => setRevoked(d.id, !d.revoked_at)}
                        >
                          {d.revoked_at ? "Re-activate" : "Unpair"}
                        </button>
                      </td>
                    </tr>
                  ))}
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
