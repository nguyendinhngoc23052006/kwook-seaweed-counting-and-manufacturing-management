import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { errorMessage } from "./lib/errorMessage";
import { loadProfile, type Profile } from "./lib/session";
import { supabase } from "./lib/supabaseClient";
import { OrgApp } from "./org/OrgApp";
import Admin from "./pages/Admin";
import Capture from "./pages/Capture";
import Claim from "./pages/Claim";
import Demo from "./pages/Demo";
import Login from "./pages/Login";
import Pair from "./pages/Pair";
import Scan from "./pages/Scan";
import Station from "./pages/Station";
import Stations from "./pages/Stations";
import Wall from "./pages/Wall";
import { PublicJobsApp } from "./public/PublicJobsApp";

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

  const pathname = window.location.pathname;

  // The demo is camera-only: no database reads, no writes, no device row. It
  // renders before the auth gate so the counter can be shown on any phone.
  if (pathname === "/demo") return <Demo />;
  // Pairing renders before the auth gate too: a camera-to-be has no session -
  // it shows a QR and receives one when an admin claims it.
  if (pathname === "/pair") return <Pair />;
  // The org-admin section (org chart, capabilities, cameras, hiring, tasks)
  // is a self-contained sibling app: its own providers, its own auth/capability
  // gate against the persons/org_nodes model, entirely separate from the
  // profiles-table gate below that the device/wall/admin pages use.
  if (pathname.startsWith("/org")) return <OrgApp />;
  // Explicit staff entry point -- the public site below has its own "Staff
  // sign in" link pointing here, so it never fights the root path for it.
  if (pathname === "/login") return <Login />;

  // Everything that isn't one of the internal employee/device routes above
  // is the public careers site, including the bare domain root: a stranger
  // sharing this URL is sharing it for the job board, not an internal login
  // screen. No account, no gate -- same reason /demo and /pair skip it.
  const STAFF_PATHS = new Set(["/capture", "/wall", "/stations", "/admin", "/claim", "/scan"]);
  const isStaffPath = STAFF_PATHS.has(pathname) || pathname.startsWith("/station/");
  if (!isStaffPath) return <PublicJobsApp />;

  if (loading) {
    return (
      <div className="wrap">
        <div className="card stack">
          <span className="skeleton">Checking your account</span>
          <span className="skeleton">One moment</span>
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="wrap">
        <div className="banner banner--crit" role="alert">
          {error}
        </div>
      </div>
    );
  }
  if (!profile) return <Login />;

  // Signed up but not yet approved: the database lets this account read nothing
  // but its own row until an owner grants it a role in Cameras.
  if (profile.kind === "human" && profile.role === "pending") {
    return (
      <div className="wrap wrap--narrow">
        <div className="empty">
          <h1 className="empty__title">Waiting for approval</h1>
          <p className="empty__body">
            Account <strong>{profile.display_name}</strong> exists but has not been approved yet. An
            owner approves it in the app; reload once they have.
          </p>
          <button
            type="button"
            className="btn btn--ghost"
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
        <Route path="/stations" element={<Stations profile={profile} />} />
        <Route path="/station/:id" element={<Station profile={profile} />} />
        <Route path="/admin" element={<Admin profile={profile} />} />
        <Route path="/claim" element={<Claim profile={profile} />} />
        <Route path="/scan" element={<Scan profile={profile} />} />
        <Route path="/demo" element={<Demo />} />
        <Route path="*" element={<Navigate to={home} replace />} />
      </Routes>
    </BrowserRouter>
  );
}
