import { QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  Link,
  Navigate,
  BrowserRouter as OrgRouter,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { Alert } from "../components/ui/Alert";
import { Button } from "../components/ui/Button";
import { Empty } from "../components/ui/EmptyState";
import { Input, Label } from "../components/ui/Input";
import { Section } from "../components/ui/Section";
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
import { createRootNode } from "../services/nodes";
import { getMyProfile } from "../services/profiles";
import { OrgErrorBoundary } from "./OrgErrorBoundary";

async function signOut() {
  await supabase().auth.signOut();
  window.location.reload();
}

// The org-admin section (capability-gated cameras today; org chart, hiring,
// tasks to follow) has no node-tree browsing page yet -- there is exactly one
// node, the Kwook root, so every route defaults straight to it rather than
// asking the owner to pick from a tree of one.
function useRootNodeId(): { rootNodeId: string | null; loading: boolean; error: string | null } {
  const [rootNodeId, setRootNodeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
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
        setLoading(false);
      });
  }, []);

  return { rootNodeId, loading, error };
}

// An organisation with no root node is not "loading" -- it is a business that
// has not been set up yet. Before this, the hub rendered a spinner that never
// resolved, so a fresh install had no first step and no way to reach one.
function FirstRun() {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const me = useQuery({ queryKey: ["profile", "me"], queryFn: getMyProfile });

  const create = useMutation({
    mutationFn: () => createRootNode(name),
    onSuccess: () => window.location.reload(),
  });

  if (me.isLoading) return <div className="p-6 text-sm text-ink-muted">{t("common.loading")}</div>;

  if (!me.data?.isAdmin) {
    return (
      <div className="p-6">
        <Empty title={t("firstrun.not_ready_title")} description={t("firstrun.not_ready_body")} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg p-6">
      <Section title={t("firstrun.title")} description={t("firstrun.body")}>
        <div className="space-y-3 py-2">
          <Label htmlFor="firstrun-name">{t("firstrun.name_label")}</Label>
          <Input
            id="firstrun-name"
            value={name}
            placeholder={t("firstrun.name_placeholder")}
            onChange={(e) => setName(e.target.value)}
          />
          {create.isError && (
            <Alert variant="error">{errorMessage(create.error, t("firstrun.failed"))}</Alert>
          )}
          <Button disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? t("common.loading") : t("firstrun.create")}
          </Button>
        </div>
      </Section>
    </div>
  );
}

// A signed-in account with no seat and no admin rights has nothing to do in the
// hub. It used to land in the full tab shell and hit an empty or failing page on
// every tab; now it gets one honest screen.
function NoSeat() {
  const { t } = useI18n();
  return (
    <div className="p-6">
      <Empty title={t("noseat.title")} description={t("noseat.body")} />
    </div>
  );
}

// The chart's tree can expand tall and wide enough that its own scrollbar
// drifts thousands of px below the fold if it just scrolls with the document.
// Only this route trades the normal document-scrolling shell for a bounded,
// self-scrolling pane -- everything else keeps scrolling the page like before.
const BOUNDED_CONTENT_ROUTES = ["/org/chart"];

function OrgRoutes() {
  const { rootNodeId, loading, error } = useRootNodeId();
  const { pathname } = useLocation();
  const isBounded = BOUNDED_CONTENT_ROUTES.includes(pathname);
  const me = useQuery({ queryKey: ["profile", "me"], queryFn: getMyProfile });

  if (error) {
    return <div className="p-6 text-sm text-danger-text">{error}</div>;
  }
  if (loading || me.isLoading) {
    return <div className="p-6 text-sm text-ink-muted">Loading…</div>;
  }
  if (!rootNodeId) {
    return <FirstRun />;
  }
  if (!me.data?.person && !me.data?.isAdmin) {
    return <NoSeat />;
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
                ? "border-b-2 border-primary text-primary-text"
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
