import { useId, useState } from "react";
import { supabase } from "../lib/supabaseClient";

export default function Login() {
  const formId = useId();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    if (creating) {
      // handle_new_user() reads raw_user_meta_data->>'display_name'; the key name
      // is a database contract, not a label.
      const { error } = await supabase().auth.signUp({
        email,
        password,
        options: { data: { display_name: email.split("@")[0] } },
      });
      if (error) setError(error.message);
      else setCreated(true);
    } else {
      const { error } = await supabase().auth.signInWithPassword({ email, password });
      if (error) setError(error.message);
      else window.location.reload();
    }
    setBusy(false);
  }

  return (
    <div className="wrap wrap--narrow">
      <div className="stack">
        <h1 className="h1">Kwook Line Vision</h1>

        {error ? (
          <div className="banner banner--crit" role="alert">
            {error}
          </div>
        ) : null}

        {created ? (
          <div className="banner banner--info">
            Account created. It can do nothing until an owner approves it — ask them to, then sign
            in.
          </div>
        ) : null}

        <div className="card">
          <form className="stack" onSubmit={submit}>
            <div className="field">
              <label className="field__label" htmlFor={`${formId}-email`}>
                Account
              </label>
              <input
                id={`${formId}-email`}
                className="field__input"
                type="email"
                value={email}
                autoComplete="username"
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <div className="field">
              <label className="field__label" htmlFor={`${formId}-password`}>
                Password
              </label>
              <input
                id={`${formId}-password`}
                className="field__input"
                type="password"
                value={password}
                autoComplete={creating ? "new-password" : "current-password"}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
              {busy ? <span className="spinner" /> : null}
              {busy
                ? creating
                  ? "Creating account…"
                  : "Signing in…"
                : creating
                  ? "Create account"
                  : "Sign in"}
            </button>

            <button
              type="button"
              className="btn btn--ghost btn--block"
              onClick={() => {
                setCreating(!creating);
                setError(null);
                setCreated(false);
              }}
            >
              {creating ? "Have an account? Sign in" : "New here? Create account"}
            </button>
          </form>
        </div>

        <a className="btn btn--ghost btn--block" href="/pair">
          Use this device as a camera
        </a>
        <p className="muted">
          Setting up a camera needs no account — an owner approves it from their own phone.
        </p>
      </div>
    </div>
  );
}
