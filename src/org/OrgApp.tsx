import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  Link,
  Navigate,
  BrowserRouter as OrgRouter,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { Button } from "../components/ui/Button";
import { errorMessage } from "../lib/errorMessage";
import { I18nProvider, useI18n } from "../lib/i18n";
import { queryClient } from "../lib/query";
import { supabase } from "../lib/supabaseClient";
import Login from "../pages/Login";
import { AttendancePage } from "../pages/org/AttendancePage";
import { CamerasPage } from "../pages/org/CamerasPage";
import { JobApplicationsPage } from "../pages/org/JobApplicationsPage";
import { JobPostingsPage } from "../pages/org/JobPostingsPage";
import { NodePage } from "../pages/org/NodePage";
import { NotificationsPage } from "../pages/org/NotificationsPage";
import { OrgChartPage } from "../pages/org/OrgChartPage";
import { PersonPage } from "../pages/org/PersonPage";
import { ProfilePage } from "../pages/org/ProfilePage";
import { UnitPage } from "../pages/org/UnitPage";
import { UnitPeoplePage } from "../pages/org/UnitPeoplePage";
import { UnitSettingsPage } from "../pages/org/UnitSettingsPage";
import { WorkPage } from "../pages/org/WorkPage";
import { OrgErrorBoundary } from "./OrgErrorBoundary";

async function signOut() {
  await supabase().auth.signOut();
  window.location.reload();
}

// The org-admin section (capability-gated cameras today; org chart, hiring,
// tasks to follow) has no node-tree browsing page yet -- there is exactly one
// node, the Kwook root, so every route defaults straight to it rather than
// asking the owner to pick from a tree of one.
function useRootNodeId(): { rootNodeId: string | null; error: string | null } {
  const [rootNodeId, setRootNodeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase()
      .from("org_nodes")
      .select("id")
      .is("parent_id", null)
      .limit(1)
      .maybeSingle()
      .then(({ data, error: err }) => {
        if (err) setError(errorMessage(err));
        else setRootNodeId(data?.id ?? null);
      });
  }, []);

  return { rootNodeId, error };
}

// The chart's tree can expand tall and wide enough that its own scrollbar
// drifts thousands of px below the fold if it just scrolls with the document.
// Only this route trades the normal document-scrolling shell for a bounded,
// self-scrolling pane -- everything else keeps scrolling the page like before.
const BOUNDED_CONTENT_ROUTES = ["/org/chart"];

function OrgRoutes() {
  const { rootNodeId, error } = useRootNodeId();
  const { pathname } = useLocation();
  const isBounded = BOUNDED_CONTENT_ROUTES.includes(pathname);

  if (error) {
    return <div className="p-6 text-sm text-danger-text">{error}</div>;
  }
  if (!rootNodeId) {
    return <div className="p-6 text-sm text-ink-muted">Loading…</div>;
  }

  const routes = (
    <Routes>
      <Route path="/org" element={<Navigate to={`/org/node/${rootNodeId}`} replace />} />
      <Route path="/org/node" element={<Navigate to={`/org/node/${rootNodeId}`} replace />} />
      <Route path="/org/node/:nodeId" element={<NodePage />} />
      <Route path="/org/node/:nodeId/summary" element={<UnitPage />} />
      <Route path="/org/node/:nodeId/people" element={<UnitPeoplePage />} />
      <Route path="/org/node/:nodeId/settings" element={<UnitSettingsPage />} />
      <Route path="/org/node/:nodeId/person/:personId" element={<PersonPage />} />
      {/* Node-scoped alias: NodePage/UnitPage/UnitSettingsPage all link here
          (`/org/node/:id/cameras`, consistent with their own `/people`,
          `/settings` siblings) -- reusing CamerasPage rather than rewriting
          those three links to the older `/org/cameras/:id` tab route. */}
      <Route path="/org/node/:nodeId/cameras" element={<CamerasPage />} />
      <Route path="/org/cameras" element={<Navigate to={`/org/cameras/${rootNodeId}`} replace />} />
      <Route path="/org/cameras/:nodeId" element={<CamerasPage />} />
      <Route
        path="/org/attendance"
        element={<Navigate to={`/org/attendance/${rootNodeId}`} replace />}
      />
      <Route path="/org/attendance/:nodeId" element={<AttendancePage />} />
      <Route path="/org/chart" element={<OrgChartPage />} />
      <Route path="/org/jobs" element={<JobPostingsPage />} />
      <Route path="/org/jobs/:jobId/applications" element={<JobApplicationsPage />} />
      <Route path="/org/work" element={<WorkPage />} />
      <Route path="/org/notifications" element={<NotificationsPage />} />
      <Route path="/org/profile" element={<ProfilePage />} />
      <Route path="*" element={<Navigate to={`/org/node/${rootNodeId}`} replace />} />
    </Routes>
  );

  if (isBounded) {
    return (
      <div className="flex h-dvh flex-col overflow-hidden">
        <div className="shrink-0 px-6 pt-6">
          <OrgNav rootNodeId={rootNodeId} />
        </div>
        <main className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pb-6">{routes}</main>
      </div>
    );
  }

  return (
    <>
      <div className="px-6 pt-6">
        <OrgNav rootNodeId={rootNodeId} />
      </div>
      <div className="px-6 pb-6">{routes}</div>
    </>
  );
}

// Three sections now exist where there was one -- a reader needs a way to move
// between them that isn't guessing at the URL bar.
function OrgNav({ rootNodeId }: { rootNodeId: string }) {
  const { t } = useI18n();
  const location = useLocation();
  const tabs: Array<{ to: string; label: string; match: string }> = [
    { to: `/org/node/${rootNodeId}`, label: t("nav.tree"), match: "/org/node" },
    { to: "/org/chart", label: t("nav.chart"), match: "/org/chart" },
    { to: `/org/cameras/${rootNodeId}`, label: t("nav.cameras"), match: "/org/cameras" },
    {
      to: `/org/attendance/${rootNodeId}`,
      label: t("nav.attendance"),
      match: "/org/attendance",
    },
    { to: "/org/jobs", label: t("nav.jobs"), match: "/org/jobs" },
    { to: "/org/work", label: t("nav.work"), match: "/org/work" },
    { to: "/org/notifications", label: t("nav.notifications"), match: "/org/notifications" },
    { to: "/org/profile", label: t("nav.me"), match: "/org/profile" },
  ];
  return (
    <nav className="mb-6 flex flex-wrap items-center justify-between gap-2 border-b border-hairline">
      <div className="flex flex-wrap gap-1">
        {tabs.map((tab) => (
          <Link
            key={tab.to}
            to={tab.to}
            className={`min-h-11 rounded-t-lg px-4 py-2 text-sm font-medium ${
              location.pathname.startsWith(tab.match)
                ? "border-b-2 border-accent text-accent-text"
                : "text-ink-muted hover:text-ink"
            }`}
          >
            {tab.label}
          </Link>
        ))}
      </div>
      <Button variant="ghost" size="sm" onClick={signOut}>
        {t("common.sign_out")}
      </Button>
    </nav>
  );
}

export function OrgApp() {
  const [user, setUser] = useState<"loading" | "signed-in" | "signed-out">("loading");
  const [configError, setConfigError] = useState<string | null>(null);

  useEffect(() => {
    // supabase() throws synchronously (missing env vars, bad config) rather
    // than rejecting -- a plain .then() chain would leave that uncaught, and
    // an effect that throws with no boundary above it white-screens the
    // whole section instead of showing what's wrong.
    try {
      supabase()
        .auth.getUser()
        .then(({ data }) => setUser(data.user ? "signed-in" : "signed-out"))
        .catch((err: unknown) => setConfigError(errorMessage(err)));
    } catch (err) {
      setConfigError(errorMessage(err));
    }
  }, []);

  return (
    <OrgErrorBoundary>
      {configError ? (
        <div className="p-6 text-sm text-danger-text">{configError}</div>
      ) : user === "loading" ? (
        <div className="p-6 text-sm text-ink-muted">Loading…</div>
      ) : user === "signed-out" ? (
        <Login />
      ) : (
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <div className="min-h-screen bg-surface-sunken">
              <OrgRouter>
                <OrgRoutes />
              </OrgRouter>
            </div>
          </I18nProvider>
        </QueryClientProvider>
      )}
    </OrgErrorBoundary>
  );
}
