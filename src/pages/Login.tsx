import { useState } from "react";
import { supabase } from "../lib/supabaseClient";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase().auth.signInWithPassword({ email, password });
    if (error) setError(error.message);
    else window.location.reload();
    setBusy(false);
  }

  return (
    <div className="wrap" style={{ maxWidth: 380 }}>
      <h1>Kwook Line Vision</h1>
      <form className="card" onSubmit={signIn}>
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
        <button type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        {error ? (
          <p className="crit" style={{ marginBottom: 0 }}>
            {error}
          </p>
        ) : null}
      </form>
    </div>
  );
}
