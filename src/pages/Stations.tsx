import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import Shell, { atLeast } from "../components/Shell";
import { errorMessage } from "../lib/errorMessage";
import type { Profile } from "../lib/session";
import { KIND_SUGGESTIONS, kindLabel } from "../lib/stationKinds";
import { supabase } from "../lib/supabaseClient";

interface LineRow {
  id: string;
  name: string;
  active: boolean;
}

interface StationRow {
  id: string;
  name: string;
  line_id: string | null;
  kind: string;
  active: boolean;
}

interface Draft {
  name: string;
  lineId: string;
  kind: string;
  active: boolean;
}

interface Group {
  line: LineRow | null;
  stations: StationRow[];
}

function groupByLine(lines: LineRow[], stations: StationRow[]): Group[] {
  const byLine = new Map<string, StationRow[]>();
  for (const station of stations) {
    const key = station.line_id ?? "";
    const list = byLine.get(key);
    if (list) list.push(station);
    else byLine.set(key, [station]);
  }
  const groups: Group[] = lines
    .filter((line) => byLine.has(line.id))
    .map((line) => ({ line, stations: byLine.get(line.id) ?? [] }));
  const unplaced = byLine.get("");
  if (unplaced) groups.push({ line: null, stations: unplaced });
  return groups;
}

// A retired line keeps the stations already on it, so it stays in that station's
// picker; it just cannot take new ones.
function lineChoices(lines: LineRow[], selectedId: string): LineRow[] {
  return lines.filter((line) => line.active || line.id === selectedId);
}

// lines_tenant_name_key is on (tenant_id, lower(btrim(name))), so the database
// is the only place that knows whether a name is taken - including by a retired
// line the owner cannot see in the pickers.
function lineWriteMessage(e: unknown, name: string): string {
  if (e !== null && typeof e === "object" && (e as { code?: unknown }).code === "23505") {
    return `A line called ${name} already exists - it may be retired. Restore that one instead of making a second.`;
  }
  return errorMessage(e);
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
  lines: LineRow[];
  kinds: string[];
  attempted: boolean;
  disabled: boolean;
  onChange: (next: Draft) => void;
}) {
  const kindListId = `${idBase}-kinds`;
  const nameMissing = attempted && draft.name.trim().length === 0;
  const lineMissing = attempted && draft.lineId.length === 0;
  const choices = lineChoices(lines, draft.lineId);

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
        <select
          id={`${idBase}-line`}
          className="field__input"
          value={draft.lineId}
          disabled={disabled}
          onChange={(e) => onChange({ ...draft, lineId: e.target.value })}
        >
          <option value="">- pick a line -</option>
          {choices.map((line) => (
            <option key={line.id} value={line.id}>
              {line.active ? line.name : `${line.name} (retired)`}
            </option>
          ))}
        </select>
        <span className="field__hint">Lines are made above, so two spellings stay one line.</span>
        {lineMissing ? (
          <span className="field__error">Every station sits on a line. Pick one.</span>
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
  const [lines, setLines] = useState<LineRow[]>([]);
  const [rows, setRows] = useState<StationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lineError, setLineError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ key: number; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [lineDraft, setLineDraft] = useState("");
  const [lineAttempted, setLineAttempted] = useState(false);
  const [editLineId, setEditLineId] = useState<string | null>(null);
  const [editLineName, setEditLineName] = useState("");
  const [addDraft, setAddDraft] = useState<Draft>({
    name: "",
    lineId: "",
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
    const [lineResult, stationResult] = await Promise.all([
      supabase().from("lines").select("id, name, active").order("name"),
      supabase().from("stations").select("id, name, line_id, kind, active").order("name"),
    ]);
    const readError = lineResult.error ?? stationResult.error;
    if (readError) {
      setError(errorMessage(readError));
      return;
    }
    setError(null);
    setLines((lineResult.data as LineRow[]) ?? []);
    setRows((stationResult.data as StationRow[]) ?? []);
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

  async function addLine(e: FormEvent) {
    e.preventDefault();
    setLineAttempted(true);
    const name = lineDraft.trim();
    if (!name) return;

    setBusy("new-line");
    const { error: writeError } = await supabase()
      .from("lines")
      .insert({ tenant_id: profile.tenant_id, name });
    if (writeError) {
      setLineError(lineWriteMessage(writeError, name));
      setBusy(null);
      return;
    }
    setLineError(null);
    setLineDraft("");
    setLineAttempted(false);
    await refresh();
    setBusy(null);
    showToast(`${name} added.`);
  }

  async function saveLineName(e: FormEvent, line: LineRow) {
    e.preventDefault();
    const name = editLineName.trim();
    if (!name) return;

    setBusy(line.id);
    const { error: writeError } = await supabase().from("lines").update({ name }).eq("id", line.id);
    if (writeError) {
      setLineError(lineWriteMessage(writeError, name));
      setBusy(null);
      return;
    }
    setLineError(null);
    setEditLineId(null);
    await refresh();
    setBusy(null);
    showToast(`${line.name} is now ${name}.`);
  }

  async function setLineActive(line: LineRow, active: boolean) {
    setBusy(line.id);
    const { error: writeError } = await supabase()
      .from("lines")
      .update({ active })
      .eq("id", line.id);
    if (writeError) {
      setLineError(errorMessage(writeError));
      setBusy(null);
      return;
    }
    setLineError(null);
    await refresh();
    setBusy(null);
    showToast(active ? `${line.name} is running again.` : `${line.name} is retired.`);
  }

  async function addStation(e: FormEvent) {
    e.preventDefault();
    setAddAttempted(true);
    const name = addDraft.name.trim();
    const lineId = addDraft.lineId;
    const kind = addDraft.kind.trim();
    if (!name || !lineId) return;

    setBusy("new");
    // tenant_id is written by hand because station_owner_write's with-check
    // compares it to the caller's tenant; the column has no default.
    const { error: writeError } = await supabase().from("stations").insert({
      tenant_id: profile.tenant_id,
      name,
      line_id: lineId,
      kind,
      active: addDraft.active,
    });
    if (writeError) {
      setError(errorMessage(writeError));
      setBusy(null);
      return;
    }
    // The line is kept: stations are added a line at a time.
    setAddDraft({ name: "", lineId, kind, active: true });
    setAddAttempted(false);
    await refresh();
    setBusy(null);
    showToast(`${name} added to ${lineName(lineId)}.`);
  }

  async function saveEdit(e: FormEvent) {
    e.preventDefault();
    if (!editId || !editDraft) return;
    setEditAttempted(true);
    const name = editDraft.name.trim();
    const lineId = editDraft.lineId;
    const kind = editDraft.kind.trim();
    if (!name || !lineId) return;

    setBusy(editId);
    const { error: writeError } = await supabase()
      .from("stations")
      .update({ name, line_id: lineId, kind, active: editDraft.active })
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
    setEditDraft({
      name: row.name,
      lineId: row.line_id ?? "",
      kind: row.kind,
      active: row.active,
    });
    setEditAttempted(false);
  }

  function lineName(lineId: string): string {
    return lines.find((line) => line.id === lineId)?.name ?? "its line";
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

  const kinds = [
    ...new Set([...rows.map((r) => r.kind.trim()), ...KIND_SUGGESTIONS].filter(Boolean)),
  ];
  const activeLines = lines.filter((line) => line.active);
  const groups = groupByLine(lines, rows);

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
        ) : (
          <>
            <div className="section">
              <div className="section__head">
                <h2 className="section__title">Lines</h2>
                <span className="muted">
                  {lines.length} line{lines.length === 1 ? "" : "s"}
                </span>
              </div>

              {lineError ? (
                <div className="banner banner--crit" role="alert">
                  {lineError}
                </div>
              ) : null}

              {canEdit ? (
                <form className="card stack" onSubmit={addLine}>
                  <div className="field">
                    <label className="field__label" htmlFor={`${formId}-new-line`}>
                      New line
                    </label>
                    <input
                      id={`${formId}-new-line`}
                      className="field__input"
                      value={lineDraft}
                      disabled={busy === "new-line"}
                      onChange={(e) => setLineDraft(e.target.value)}
                    />
                    <span className="field__hint">
                      A line is a run of the floor that stations sit on. Name it the way the floor
                      does.
                    </span>
                    {lineAttempted && lineDraft.trim().length === 0 ? (
                      <span className="field__error">Give the line a name.</span>
                    ) : null}
                  </div>
                  <div className="row">
                    <button
                      type="submit"
                      className="btn btn--primary"
                      disabled={busy === "new-line"}
                    >
                      {busy === "new-line" ? <span className="spinner" /> : null}
                      Add line
                    </button>
                  </div>
                </form>
              ) : null}

              {lines.length === 0 ? (
                <p className="muted">
                  No lines yet. A station has to sit on one, so name your first line above.
                </p>
              ) : (
                <div className="grid grid--wide">
                  {lines.map((line) => {
                    const count = rows.filter((row) => row.line_id === line.id).length;
                    return editLineId === line.id ? (
                      <div className="card" key={line.id}>
                        <form className="stack" onSubmit={(e) => saveLineName(e, line)}>
                          <div className="field">
                            <label className="field__label" htmlFor={`${formId}-line-${line.id}`}>
                              Line name
                            </label>
                            <input
                              id={`${formId}-line-${line.id}`}
                              className="field__input"
                              value={editLineName}
                              disabled={busy === line.id}
                              onChange={(e) => setEditLineName(e.target.value)}
                            />
                          </div>
                          <div className="row">
                            <button
                              type="submit"
                              className="btn btn--primary"
                              disabled={busy === line.id}
                            >
                              {busy === line.id ? <span className="spinner" /> : null}
                              Save
                            </button>
                            <button
                              type="button"
                              className="btn btn--ghost"
                              disabled={busy === line.id}
                              onClick={() => setEditLineId(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        </form>
                      </div>
                    ) : (
                      <div className="card" key={line.id}>
                        <div className="row">
                          <strong>{line.name}</strong>
                          <span className={line.active ? "pill pill--ok" : "pill pill--idle"}>
                            {line.active ? "running" : "retired"}
                          </span>
                        </div>
                        <p className="muted">
                          {count} station{count === 1 ? "" : "s"}
                        </p>
                        {canEdit ? (
                          <div className="row">
                            <button
                              type="button"
                              className="btn"
                              disabled={busy === line.id}
                              onClick={() => {
                                setEditLineId(line.id);
                                setEditLineName(line.name);
                              }}
                            >
                              Rename
                            </button>
                            {/* No delete, ever: stations point at line_id, and every count
                                points at a station. Retiring keeps the history readable. */}
                            <button
                              type="button"
                              className="btn"
                              disabled={busy === line.id}
                              onClick={() => setLineActive(line, !line.active)}
                            >
                              {line.active ? "Retire" : "Restore"}
                            </button>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {canEdit ? (
              <div className="card">
                {activeLines.length === 0 ? (
                  <div className="stack">
                    <h2 className="section__title">Add a station</h2>
                    <p className="muted">
                      A station sits on a line, so make a line first with Add line above. Then this
                      form can put the station on it.
                    </p>
                  </div>
                ) : (
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
                )}
              </div>
            ) : (
              <div className="banner banner--info">
                Managers can read the floor layout. Only an owner can add or change a line or a
                station.
              </div>
            )}

            {rows.length === 0 ? (
              <div className="empty">
                <h2 className="empty__title">No stations yet</h2>
                <p className="empty__body">
                  A station is a physical spot on the floor that one camera points at - a tray
                  table, a stretch of belt, a doorway. Cameras cannot be usefully paired until at
                  least one exists: a camera with no station has nowhere to file what it counts.
                </p>
              </div>
            ) : null}

            {groups.map((group) => (
              <div className="section" key={group.line?.id ?? "unplaced"}>
                <div className="section__head">
                  <h2 className="section__title">{group.line ? group.line.name : "No line"}</h2>
                  <span className="muted">
                    {group.line?.active === false ? "retired · " : ""}
                    {group.stations.length} station{group.stations.length === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="grid grid--wide">
                  {group.stations.map((row) =>
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
          </>
        )}
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
