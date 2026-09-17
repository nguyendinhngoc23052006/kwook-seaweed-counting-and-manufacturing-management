import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { errorMessage } from "../lib/errorMessage";
import type { Profile } from "../lib/session";
import { supabase } from "../lib/supabaseClient";

// The owner side of pairing: opened by scanning the QR a waiting camera shows.
// The secret rides the URL fragment (never sent to any server); submitting
// calls the pair-claim Edge Function, which does all privileged work.
export default function Claim({ profile }: { profile: Profile }) {
  const code = window.location.hash.slice(1);
  const formId = useId();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (profile.role !== "owner") {
    return (
      <div className="wrap wrap--narrow">
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
      <div className="wrap wrap--narrow">
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
    // func is the literal the server-side catalog accepts, not a choice made
    // here: where a camera stands and what it runs are the owner's to set on
    // the devices row in Cameras, never asked of the camera or its claimer.
    const { data, error } = await supabase().functions.invoke("pair-claim", {
      body: { code, name, func: "counting" },
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

  if (done) {
    return (
      <div className="wrap wrap--narrow">
        <div className="stack">
          <h1 className="h1">Paired</h1>
          <div className="card">
            <strong>{name}</strong> exists now, standing nowhere. Give it a line, a station and a
            function on the Cameras screen — a camera shows only what it is told.
          </div>
          <div className="row">
            <Link className="btn btn--primary" to="/admin">
              Place this camera
            </Link>
            <Link className="btn btn--ghost" to="/scan">
              Pair another camera
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="wrap wrap--narrow">
      <div className="stack">
        <h1 className="h1">Pair a camera</h1>

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
                A name you will recognise on the wall — usually where it is, not what it is. You
                choose its line, station and function next, on the Cameras screen.
              </span>
            </div>

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
