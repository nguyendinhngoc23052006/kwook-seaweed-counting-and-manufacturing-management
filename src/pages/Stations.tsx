import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import Shell, { atLeast } from "../components/Shell";
import { errorMessage } from "../lib/errorMessage";
import type { Profile } from "../lib/session";
import { KIND_SUGGESTIONS, kindLabel } from "../lib/stationKinds";
import { supabase } from "../lib/supabaseClient";

interface StationRow {
  id: string;
  name: string;
  line: string;
  kind: string;
  active: boolean;
}

interface Draft {
  name: string;
  line: string;
  kind: string;
  active: boolean;
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

function StationFields({
  idBase,
  draft,
  lines,
  kinds,
  attempted,
  disabled,
  onChange,
}: {
  idBase: string;
  draft: Draft;
  lines: string[];
  kinds: string[];
  attempted: boolean;
  disabled: boolean;
  onChange: (next: Draft) => void;
}) {
  const listId = `${idBase}-lines`;
  const kindListId = `${idBase}-kinds`;
  const nameMissing = attempted && draft.name.trim().length === 0;
  const lineMissing = attempted && draft.line.trim().length === 0;

  return (
    <div className="grid">
      <div className="field">
        <label className="field__label" htmlFor={`${idBase}-name`}>
          Station name
        </label>
        <input
          id={`${idBase}-name`}
          className="field__input"
          value={draft.name}
          disabled={disabled}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
        />
        {nameMissing ? (
          <span className="field__error">Give the station a name people on the floor use.</span>
        ) : null}
      </div>

      <div className="field">
        <label className="field__label" htmlFor={`${idBase}-line`}>
          Production line
        </label>
        <input
          id={`${idBase}-line`}
          className="field__input"
          list={listId}
          value={draft.line}
          disabled={disabled}
          onChange={(e) => onChange({ ...draft, line: e.target.value })}
        />
        <datalist id={listId}>
          {lines.map((line) => (
            <option key={line} value={line} />
          ))}
        </datalist>
        <span className="field__hint">Type a new line, or pick one you already use.</span>
        {lineMissing ? (
          <span className="field__error">Every station sits on a line. Name it.</span>
        ) : null}
      </div>

      <div className="field">
        <label className="field__label" htmlFor={`${idBase}-kind`}>
          Kind of place
        </label>
        <input
          id={`${idBase}-kind`}
          className="field__input"
          list={kindListId}
          value={draft.kind}
          disabled={disabled}
          onChange={(e) => onChange({ ...draft, kind: e.target.value })}
        />
        <datalist id={kindListId}>
          {kinds.map((kind) => (
            <option key={kind} value={kind} />
          ))}
        </datalist>
        <span className="field__hint">What this place is called on your floor. Optional.</span>
      </div>

      <div className="field field--inline">
        <label className="field__label" htmlFor={`${idBase}-active`}>
          Active
        </label>
        <input
          id={`${idBase}-active`}
          type="checkbox"
          checked={draft.active}
          disabled={disabled}
          onChange={(e) => onChange({ ...draft, active: e.target.checked })}
        />
        <span className="field__hint">
          Inactive stations keep their history but leave the pickers.
        </span>
      </div>
    </div>
  );
}

export default function Stations({ profile }: { profile: Profile }) {
  const formId = useId();
  const [rows, setRows] = useState<StationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ key: number; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [addDraft, setAddDraft] = useState<Draft>({
    name: "",
    line: "",
    kind: "",
    active: true,
  });
  const [addAttempted, setAddAttempted] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Draft | null>(null);
  const [editAttempted, setEditAttempted] = useState(false);

  const canView = atLeast(profile.role, "manager");
  const canEdit = atLeast(profile.role, "owner");

  // Optimistic UI is deliberately absent: every write is followed by a re-read,
  // so what the screen shows is what RLS actually let through.
  const refresh = useCallback(async () => {
    const { data, error: readError } = await supabase()
      .from("stations")
      .select("id, name, line, kind, active")
      .order("line")
      .order("name");
    if (readError) {
      setError(errorMessage(readError));
      return;
    }
    setError(null);
    setRows((data as StationRow[]) ?? []);
  }, []);

  useEffect(() => {
    if (!canView) {
      setLoading(false);
      return;
    }
    void refresh().finally(() => setLoading(false));
  }, [canView, refresh]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  function showToast(text: string) {
    setToast({ key: Date.now(), text });
  }

  async function addStation(e: FormEvent) {
    e.preventDefault();
    setAddAttempted(true);
    const name = addDraft.name.trim();
    const line = addDraft.line.trim();
    const kind = addDraft.kind.trim();
    if (!name || !line) return;

    setBusy("new");
    // tenant_id is written by hand because station_owner_write's with-check
    // compares it to the caller's tenant; the column has no default.
    const { error: writeError } = await supabase().from("stations").insert({
      tenant_id: profile.tenant_id,
      name,
      line,
      kind,
      active: addDraft.active,
    });
    if (writeError) {
      setError(errorMessage(writeError));
      setBusy(null);
      return;
    }
    // The line is kept: stations are added a line at a time.
    setAddDraft({ name: "", line, kind, active: true });
    setAddAttempted(false);
    await refresh();
    setBusy(null);
    showToast(`${name} added to ${line}.`);
  }

  async function saveEdit(e: FormEvent) {
    e.preventDefault();
    if (!editId || !editDraft) return;
    setEditAttempted(true);
    const name = editDraft.name.trim();
    const line = editDraft.line.trim();
    const kind = editDraft.kind.trim();
    if (!name || !line) return;

    setBusy(editId);
    const { error: writeError } = await supabase()
      .from("stations")
      .update({ name, line, kind, active: editDraft.active })
      .eq("id", editId);
    if (writeError) {
      setError(errorMessage(writeError));
      setBusy(null);
      return;
    }
    setEditId(null);
    setEditDraft(null);
    setEditAttempted(false);
    await refresh();
    setBusy(null);
    showToast(`${name} saved.`);
  }

  async function setActive(row: StationRow, active: boolean) {
    setBusy(row.id);
    const { error: writeError } = await supabase()
      .from("stations")
      .update({ active })
      .eq("id", row.id);
    if (writeError) {
      setError(errorMessage(writeError));
      setBusy(null);
      return;
    }
    await refresh();
    setBusy(null);
    showToast(active ? `${row.name} is back in service.` : `${row.name} is deactivated.`);
  }

  function startEdit(row: StationRow) {
    setEditId(row.id);
    setEditDraft({ name: row.name, line: row.line, kind: row.kind, active: row.active });
    setEditAttempted(false);
  }

  if (!canView) {
    return (
      <Shell profile={profile} active="stations">
        <div className="empty">
          <h2 className="empty__title">Manager access required</h2>
          <p className="empty__body">
            Stations describe the factory floor, so managers and owners maintain them. Ask an owner
            to raise your role if you need this screen.
          </p>
        </div>
      </Shell>
    );
  }

  const lines = [...new Set(rows.map((r) => r.line))];
  const kinds = [
    ...new Set([...rows.map((r) => r.kind.trim()), ...KIND_SUGGESTIONS].filter(Boolean)),
  ];
  const groups = groupByLine(rows);

  return (
    <Shell profile={profile} active="stations">
      <div className="stack">
        <div className="section__head">
          <h1 className="h1">Stations</h1>
          <span className="muted">
            {rows.length} station{rows.length === 1 ? "" : "s"} on {lines.length} line
            {lines.length === 1 ? "" : "s"}
          </span>
        </div>

        {error ? (
          <div className="banner banner--crit" role="alert">
            {error}
          </div>
        ) : null}

        {canEdit ? (
          <div className="card">
            <form className="stack" onSubmit={addStation}>
              <h2 className="section__title">Add a station</h2>
              <StationFields
                idBase={`${formId}-add`}
                draft={addDraft}
                lines={lines}
                kinds={kinds}
                attempted={addAttempted}
                disabled={busy === "new"}
                onChange={setAddDraft}
              />
              <div className="row">
                <button type="submit" className="btn btn--primary" disabled={busy === "new"}>
                  {busy === "new" ? <span className="spinner" /> : null}
                  Add station
                </button>
              </div>
            </form>
          </div>
        ) : (
          <div className="banner banner--info">
            Managers can read the floor layout. Only an owner can add or change a station.
          </div>
        )}

        {loading ? (
          <div className="section">
            <h2 className="section__title skeleton">Loading lines</h2>
            <div className="grid">
              {["a", "b", "c"].map((key) => (
                <div className="card" key={key}>
                  <p className="skeleton">Station name</p>
                  <p className="skeleton">Kind of place</p>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {!loading && rows.length === 0 ? (
          <div className="empty">
            <h2 className="empty__title">No stations yet</h2>
            <p className="empty__body">
              A station is a physical spot on the floor that one camera points at — a tray table, a
              stretch of belt, a doorway. Cameras cannot be usefully paired until at least one
              exists: a camera with no station has nowhere to file what it counts.
            </p>
          </div>
        ) : null}

        {!loading &&
          groups.map(([line, list]) => (
            <div className="section" key={line}>
              <div className="section__head">
                <h2 className="section__title">{line}</h2>
                <span className="muted">
                  {list.length} station{list.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="grid grid--wide">
                {list.map((row) =>
                  editId === row.id && editDraft ? (
                    <div className="card" key={row.id}>
                      <form className="stack" onSubmit={saveEdit}>
                        <StationFields
                          idBase={`${formId}-${row.id}`}
                          draft={editDraft}
                          lines={lines}
                          kinds={kinds}
                          attempted={editAttempted}
                          disabled={busy === row.id}
                          onChange={setEditDraft}
                        />
                        <div className="row">
                          <button
                            type="submit"
                            className="btn btn--primary"
                            disabled={busy === row.id}
                          >
                            {busy === row.id ? <span className="spinner" /> : null}
                            Save
                          </button>
                          <button
                            type="button"
                            className="btn btn--ghost"
                            disabled={busy === row.id}
                            onClick={() => {
                              setEditId(null);
                              setEditDraft(null);
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    </div>
                  ) : (
                    <div className="card" key={row.id}>
                      <div className="row">
                        <strong>{row.name}</strong>
                        <span className={row.active ? "pill pill--ok" : "pill pill--idle"}>
                          {row.active ? "active" : "inactive"}
                        </span>
                      </div>
                      <p className="muted">{kindLabel(row.kind)}</p>
                      {canEdit ? (
                        <div className="row">
                          <button
                            type="button"
                            className="btn"
                            disabled={busy === row.id}
                            onClick={() => startEdit(row)}
                          >
                            Edit
                          </button>
                          {/* No delete, ever: count rows point at station_id, and a month
                              that has been reported has to stay explainable. */}
                          <button
                            type="button"
                            className="btn"
                            disabled={busy === row.id}
                            onClick={() => setActive(row, !row.active)}
                          >
                            {row.active ? "Deactivate" : "Activate"}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ),
                )}
              </div>
            </div>
          ))}
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
