import { useCallback, useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import { errorMessage } from "../lib/errorMessage";
import { FUNCTIONS } from "../lib/functionsCatalog";
import type { DeviceRole, Profile } from "../lib/session";
import { supabase } from "../lib/supabaseClient";

interface StationRow {
  id: string;
  name: string;
}

// Picking this opens the inline creator instead of selecting a station: on a
// fresh tenant the list is empty, and the owner is standing at the machine.
const NEW_STATION = "__new__";

// The owner side of pairing: opened by scanning the QR a waiting camera shows.
// The secret rides the URL fragment (never sent to any server); submitting
// calls the pair-claim Edge Function, which does all privileged work.
export default function Claim({ profile }: { profile: Profile }) {
  const code = window.location.hash.slice(1);
  const formId = useId();
  const [name, setName] = useState("");
  const [func, setFunc] = useState<DeviceRole>("counting");
  const [stationId, setStationId] = useState("");
  const [stations, setStations] = useState<StationRow[]>([]);
  const [loadingStations, setLoadingStations] = useState(true);
  const [stationError, setStationError] = useState<string | null>(null);
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newLine, setNewLine] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStations = useCallback(async () => {
    const { data, error: readError } = await supabase()
      .from("stations")
      .select("id, name")
      .order("name");
    if (readError) {
      setStationError(errorMessage(readError));
      return [] as StationRow[];
    }
    const rows = (data as StationRow[]) ?? [];
    setStationError(null);
    setStations(rows);
    return rows;
  }, []);

  useEffect(() => {
    void loadStations().then((rows) => {
      // Nothing to pick means the creator is the only way forward.
      if (rows.length === 0) setCreatorOpen(true);
      setLoadingStations(false);
    });
  }, [loadStations]);

  if (profile.role !== "owner") {
    return (
      <div className="wrap">
        <div className="empty">
          <h2 className="empty__title">Owner access required</h2>
          <p className="empty__body">
            Pairing a camera creates a device account, so only an owner can do it. Ask an owner to
            scan the code this camera is showing.
          </p>
        </div>
      </div>
    );
  }
  if (!code || code.length < 32) {
    return (
      <div className="wrap">
        <div className="empty">
          <h2 className="empty__title">No pairing code in this link</h2>
          <p className="empty__body">
            The code travels inside the link and is missing here. Scan the QR shown on the camera
            again.
          </p>
        </div>
      </div>
    );
  }

  async function claim(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { data, error } = await supabase().functions.invoke("pair-claim", {
      body: { code, name, func, station_id: stationId || null },
    });
    if (error) {
      // functions.invoke throws on a non-2xx status and hides our JSON body
      // behind a generic message; dig the real reason out of the Response it
      // stashes on error.context so the admin sees what actually failed.
      let detail = errorMessage(error);
      const ctx = (error as { context?: unknown }).context;
      if (ctx instanceof Response) {
        const body = await ctx.json().catch(() => null);
        if (body && typeof body === "object" && "error" in body) {
          detail = String((body as { error: unknown }).error);
        }
      }
      setError(detail);
    } else if (data && typeof data === "object" && "error" in data && data.error) {
      setError(String((data as { error: unknown }).error));
    } else setDone(true);
    setBusy(false);
  }

  async function createStation() {
    const stationName = newName.trim();
    const line = newLine.trim();
    if (!stationName || !line) return;
    setCreating(true);
    setStationError(null);
    // tenant_id is written by hand because station_owner_write's with-check
    // compares it to the caller's tenant; the column has no default. A station
    // kind and a device function share one vocabulary, so the function chosen
    // above is the right kind for the station this camera will point at.
    const { data, error: writeError } = await supabase()
      .from("stations")
      .insert({ tenant_id: profile.tenant_id, name: stationName, line, kind: func })
      .select("id")
      .single();
    if (writeError) {
      setStationError(errorMessage(writeError));
      setCreating(false);
      return;
    }
    await loadStations();
    setStationId((data as { id: string }).id);
    setNewName("");
    setNewLine("");
    setCreatorOpen(false);
    setCreating(false);
  }

  if (done) {
    return (
      <div className="wrap">
        <div className="stack">
          <h1 className="h1">Paired</h1>
          <div className="card">
            <strong>{name}</strong> is set up. The camera's screen switches to the counting view by
            itself within a few seconds.
          </div>
          <div className="row">
            <Link className="btn btn--primary" to="/scan">
              Pair another camera
            </Link>
            <Link className="btn btn--ghost" to="/admin">
              Back to cameras
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const noStations = !loadingStations && stations.length === 0;
  const canCreate = newName.trim().length > 0 && newLine.trim().length > 0;

  return (
    <div className="wrap">
      <div className="stack">
        <h1 className="h1">Pair a camera</h1>

        {noStations ? (
          <div className="banner banner--info">
            A station is the spot on the floor this camera points at — a tray table, a stretch of
            belt, a doorway. There are none yet, so make the first one right here.
          </div>
        ) : null}

        {stationError ? (
          <div className="banner banner--crit" role="alert">
            {stationError}
          </div>
        ) : null}

        <div className="card">
          <form className="stack" onSubmit={claim}>
            <div className="field">
              <label className="field__label" htmlFor={`${formId}-name`}>
                Camera name
              </label>
              <input
                id={`${formId}-name`}
                className="field__input"
                value={name}
                placeholder="Machine 1"
                onChange={(e) => setName(e.target.value)}
              />
              <span className="field__hint">
                A name you will recognise on the wall — usually where it is, not what it is.
              </span>
            </div>

            <div className="field">
              <label className="field__label" htmlFor={`${formId}-func`}>
                Function
              </label>
              <select
                id={`${formId}-func`}
                className="field__input"
                value={func}
                onChange={(e) => setFunc(e.target.value as DeviceRole)}
              >
                {FUNCTIONS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label className="field__label" htmlFor={`${formId}-station`}>
                Station
              </label>
              {loadingStations ? (
                <span className="skeleton">Loading stations</span>
              ) : (
                <div className="field field--inline">
                  <select
                    id={`${formId}-station`}
                    className="field__input"
                    value={stationId}
                    onChange={(e) => {
                      if (e.target.value === NEW_STATION) {
                        setCreatorOpen(true);
                        return;
                      }
                      setStationId(e.target.value);
                    }}
                  >
                    <option value="">no station</option>
                    {stations.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                    <option value={NEW_STATION}>+ New station</option>
                  </select>
                  {creatorOpen ? null : (
                    <button type="button" className="btn" onClick={() => setCreatorOpen(true)}>
                      + New station
                    </button>
                  )}
                </div>
              )}
              {!loadingStations && stationId === "" ? (
                <span className="field__hint">
                  With no station its counts will not appear on the Wall until one is assigned.
                </span>
              ) : null}
            </div>

            {creatorOpen ? (
              <div className="card stack">
                <div className="field">
                  <label className="field__label" htmlFor={`${formId}-new-name`}>
                    New station name
                  </label>
                  <input
                    id={`${formId}-new-name`}
                    className="field__input"
                    value={newName}
                    placeholder="Tray table 3"
                    onChange={(e) => setNewName(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label className="field__label" htmlFor={`${formId}-new-line`}>
                    Production line
                  </label>
                  <input
                    id={`${formId}-new-line`}
                    className="field__input"
                    value={newLine}
                    placeholder="Line A"
                    onChange={(e) => setNewLine(e.target.value)}
                  />
                  <span className="field__hint">Stations are grouped by line on the Wall.</span>
                </div>
                <div className="row">
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={creating || !canCreate}
                    onClick={() => void createStation()}
                  >
                    {creating ? <span className="spinner" /> : null}
                    {creating ? "Creating…" : "Create station"}
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    disabled={creating}
                    onClick={() => setCreatorOpen(false)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}

            <button
              type="submit"
              className="btn btn--primary btn--block"
              disabled={busy || name.trim().length === 0}
            >
              {busy ? "Pairing…" : "Pair this camera"}
            </button>

            {error ? (
              <div className="banner banner--crit" role="alert">
                {error}
              </div>
            ) : null}
          </form>
        </div>
      </div>
    </div>
  );
}
