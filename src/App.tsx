import { lazy, Suspense, useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { errorMessage } from "./lib/errorMessage";
import { type DoorCamera, loadDoorCamera, loadProfile, type Profile } from "./lib/session";
import { supabase } from "./lib/supabaseClient";
import Login from "./pages/Login";

// Three audiences share this one build (the camera/device console, the org
// management hub, and the public careers site), and a visitor only ever uses
// one of them. Eagerly importing all three put every audience's code in a
// single ~1MB bundle every visitor downloaded regardless of which one they
// were there for -- lazy() splits each into its own chunk, fetched only when
// that path is actually reached.
const OrgApp = lazy(() => import("./org/OrgApp").then((m) => ({ default: m.OrgApp })));
const PublicJobsApp = lazy(() =>
  import("./public/PublicJobsApp").then((m) => ({ default: m.PublicJobsApp })),
);
const AttendanceCamera = lazy(() => import("./pages/AttendanceCamera"));
const Capture = lazy(() => import("./pages/Capture"));
const Pair = lazy(() => import("./pages/Pair"));
const Station = lazy(() => import("./pages/Station"));
const Wall = lazy(() => import("./pages/Wall"));

// Reused at every Suspense boundary below rather than each site inventing its
// own -- same visual language as the profile-loading card just past it.
// App.tsx and OrgApp.tsx are separate BrowserRouter trees, so a <Navigate> from
// one into the other resolves to nothing. Leaving the SPA is a real navigation.
function HardRedirect({ to }: { to: string }) {
  useEffect(() => {
    window.location.replace(to);
  }, [to]);
  return <PageLoading />;
}

function PageLoading() {
  return (
    <div className="wrap">
      <div className="card stack">
        <span className="skeleton">Loading</span>
      </div>
    </div>
  );
}

export default function App() {
  const [profile, setProfile] = useState<Profile | null>(null);
  // Stack B (the org camera stack) gives a device profile its own row here,
  // separate from the counting-stack `devices` row `loadDeviceConfig` reads.
  const [door, setDoor] = useState<DoorCamera | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const loaded = await loadProfile();
        setProfile(loaded);
        if (loaded?.kind === "device") setDoor(await loadDoorCamera(loaded.id));
      } catch (e: unknown) {
        setError(errorMessage(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const pathname = window.location.pathname;

  // Pairing renders before the auth gate: a camera-to-be has no session - it
  // shows a QR and receives one when a manager claims it.
  if (pathname === "/pair")
    return (
      <Suspense fallback={<PageLoading />}>
        <Pair />
      </Suspense>
    );
  // The org-admin section (org chart, capabilities, cameras, hiring, tasks)
  // is a self-contained sibling app: its own providers, its own auth/capability
  // gate against the persons/org_nodes model, entirely separate from the
  // profiles-table gate below that the device and wall pages use.
  if (pathname.startsWith("/org"))
    return (
      <Suspense fallback={<PageLoading />}>
        <OrgApp />
      </Suspense>
    );

  // Everything that isn't one of the internal employee/device routes above
  // is the public careers site, including the bare domain root: a stranger
  // sharing this URL is sharing it for the job board, not an internal login
  // screen. No account, no gate -- same reason /pair skips it.
  //
  // /login is a staff path, not public -- but it must NOT hard-render <Login/>
  // here. Login's own submit handler does window.location.reload() on the SAME
  // url to pick up the new session; a pathname === "/login" check above the
  // profile check would fire again on that reload before profile ever loads,
  // showing the form forever no matter how many times the sign-in succeeded.
  // Falling through to the ordinary gate below (loading -> !profile -> Login,
  // else redirected home by the BrowserRouter's catch-all) is what lets the
  // reload actually notice the new session.
  const STAFF_PATHS = new Set(["/camera", "/capture", "/wall", "/login", "/attendance"]);
  const isStaffPath = STAFF_PATHS.has(pathname) || pathname.startsWith("/station/");
  if (!isStaffPath)
    return (
      <Suspense fallback={<PageLoading />}>
        <PublicJobsApp />
      </Suspense>
    );

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

  // A device still boots straight to its own screen. A human belongs in the
  // management hub -- the counting wall is one module inside the business, not
  // the front door to it. /wall and /station/:id stay reachable by name;
  // cameras and stations are managed in the hub, at /org/cameras.
  const home = profile.kind === "device" ? (door ? "/attendance" : "/capture") : "/org";

  return (
    <BrowserRouter>
      <Suspense fallback={<PageLoading />}>
        <Routes>
          {/* Where a just-paired camera lands. It cannot know its own role
              until its row is read, and this is the one place that knows: it
              resolves to the screen this camera is actually for. */}
          <Route path="/camera" element={<Navigate to={home} replace />} />
          {/* Each camera screen refuses the other one's cameras. A door camera
              rendering the counting screen would sit there recording nothing
              anyone asked for, so the guard runs both ways. */}
          <Route
            path="/capture"
            element={door ? <Navigate to="/attendance" replace /> : <Capture profile={profile} />}
          />
          <Route
            path="/attendance"
            element={door ? <AttendanceCamera door={door} /> : <Navigate to={home} replace />}
          />
          <Route path="/wall" element={<Wall profile={profile} />} />
          <Route path="/station/:id" element={<Station profile={profile} />} />
          <Route
            path="*"
            element={
              home.startsWith("/org") ? <HardRedirect to={home} /> : <Navigate to={home} replace />
            }
          />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
