import { useState } from "react";
import { supabase } from "../lib/supabaseClient";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    // New accounts land as 'pending' and can do nothing until the owner
    // approves them in the Supabase dashboard.
    const { error } = creating
      ? await supabase().auth.signUp({
          email,
          password,
          options: { data: { display_name: email.split("@")[0] } },
        })
      : await supabase().auth.signInWithPassword({ email, password });
    if (error) setError(error.message);
    else window.location.reload();
    setBusy(false);
  }

  return (
    <div className="wrap" style={{ maxWidth: 380 }}>
      <h1>Kwook Line Vision</h1>
      <form className="card" onSubmit={submit}>
        <div className="label">Account</div>
        <input
          id="email"
          type="email"
          value={email}
          autoComplete="username"
          onChange={(e) => setEmail(e.target.value)}
          style={{ width: "100%", marginBottom: 8 }}
        />
        <div className="label">Password</div>
        <input
          id="password"
          type="password"
          value={password}
          autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)}
          style={{ width: "100%", marginBottom: 12 }}
        />
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <button type="submit" disabled={busy} style={{ width: "100%" }}>
            {busy ? "Working…" : creating ? "Create account" : "Sign in"}
          </button>
          <button
            type="button"
            className="secondary"
            style={{ width: "100%" }}
            onClick={() => {
              setCreating(!creating);
              setError(null);
            }}
          >
            {creating ? "Have an account? Sign in" : "New here? Create account"}
          </button>
        </div>
        {creating ? (
          <p className="label" style={{ marginBottom: 0 }}>
            New accounts wait for admin approval before they can do anything.
          </p>
        ) : null}
        <p className="label" style={{ marginBottom: 0 }}>
          Setting up a camera? <a href="/pair">Use this device as a camera</a> - no account needed.
        </p>
        {error ? (
          <p className="crit" style={{ marginBottom: 0 }}>
            {error}
          </p>
        ) : null}
      </form>
    </div>
  );
}
