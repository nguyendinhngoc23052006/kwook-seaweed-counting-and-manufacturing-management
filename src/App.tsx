import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { errorMessage } from "./lib/errorMessage";
import { loadProfile, type Profile } from "./lib/session";
import { supabase } from "./lib/supabaseClient";
import Admin from "./pages/Admin";
import Capture from "./pages/Capture";
import Demo from "./pages/Demo";
import Login from "./pages/Login";
import Wall from "./pages/Wall";

export default function App() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadProfile()
      .then(setProfile)
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setLoading(false));
  }, []);

  // The demo is camera-only: no database reads, no writes, no device row. It
  // renders before the auth gate so the counter can be shown on any phone.
  if (window.location.pathname === "/demo") return <Demo />;

  if (loading) return <div className="wrap">Loading…</div>;
  if (error) {
    return (
      <div className="wrap">
        <div className="card crit">{error}</div>
      </div>
    );
  }
  if (!profile) return <Login />;

  // Signed up but not yet approved. The owner promotes the account by hand in
  // the Supabase dashboard (Table Editor -> profiles -> role); until then the
  // database lets this account read nothing but its own row.
  if (profile.kind === "human" && profile.role === "pending") {
    return (
      <div className="wrap" style={{ maxWidth: 420 }}>
        <div className="card">
          <h1>Waiting for approval</h1>
          <p>
            Account <strong>{profile.display_name}</strong> exists but has not been approved yet.
            Ask the administrator to approve it, then reload.
          </p>
          <button
            type="button"
            className="secondary"
            onClick={async () => {
              await supabase().auth.signOut();
              window.location.reload();
            }}
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  const home = profile.kind === "device" ? "/capture" : "/wall";

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/capture" element={<Capture profile={profile} />} />
        <Route path="/wall" element={<Wall profile={profile} />} />
        <Route path="/admin" element={<Admin profile={profile} />} />
        <Route path="/demo" element={<Demo />} />
        <Route path="*" element={<Navigate to={home} replace />} />
      </Routes>
    </BrowserRouter>
  );
}
