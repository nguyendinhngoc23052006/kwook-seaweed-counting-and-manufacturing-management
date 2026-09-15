import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { loadProfile, type Profile } from "./lib/session";
import Admin from "./pages/Admin";
import Capture from "./pages/Capture";
import Login from "./pages/Login";
import Wall from "./pages/Wall";

export default function App() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadProfile()
      .then(setProfile)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="wrap">Loading…</div>;
  if (error) {
    return (
      <div className="wrap">
        <div className="card crit">{error}</div>
      </div>
    );
  }
  if (!profile) return <Login />;

  const home = profile.kind === "device" ? "/capture" : "/wall";

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/capture" element={<Capture profile={profile} />} />
        <Route path="/wall" element={<Wall profile={profile} />} />
        <Route path="/admin" element={<Admin profile={profile} />} />
        <Route path="*" element={<Navigate to={home} replace />} />
      </Routes>
    </BrowserRouter>
  );
}
