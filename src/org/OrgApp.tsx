import { QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { Navigate, BrowserRouter as OrgRouter, Route, Routes, useLocation } from "react-router-dom";
import { Alert } from "../components/ui/Alert";
import { Button } from "../components/ui/Button";
import { Empty, ErrorState } from "../components/ui/EmptyState";
import { Input, Label } from "../components/ui/Input";
import { Section } from "../components/ui/Section";
import { ListSkeleton } from "../components/ui/Skeleton";
import { errorMessage } from "../lib/errorMessage";
import { I18nProvider, useI18n } from "../lib/i18n";
import { queryClient } from "../lib/query";
import { loadProfile } from "../lib/session";
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
import { RanksPage } from "../pages/org/RanksPage";
import { UnitPage } from "../pages/org/UnitPage";
import { UnitPeoplePage } from "../pages/org/UnitPeoplePage";
import { UnitSettingsPage } from "../pages/org/UnitSettingsPage";
import { WorkPage } from "../pages/org/WorkPage";
import { createRootNode } from "../services/nodes";
import { getMyProfile } from "../services/profiles";
import { OrgErrorBoundary } from "./OrgErrorBoundary";
import { OrgShell } from "./OrgShell";

// The org-admin section (capability-gated cameras today; org chart, hiring,
// tasks to follow) has no node-tree browsing page yet -- there is exactly one
// node, the Kwook root, so every route defaults straight to it rather than
// asking the owner to pick from a tree of one.
function useRootNode(): {
  rootNodeId: string | null;
  orgName: string;
  loading: boolean;
  error: string | null;
} {
  const [rootNodeId, setRootNodeId] = useState<string | null>(null);
  const [orgName, setOrgName] = useState("Kwook");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase()
      .from("org_nodes")
      .select("id, name")
      .is("parent_id", null)
      .limit(1)
      .maybeSingle()
      .then(({ data, error: err }) => {
        if (err) setError(errorMessage(err));
        else {
          setRootNodeId(data?.id ?? null);
          if (data?.name) setOrgName(data.name);
        }
        setLoading(false);
      });
  }, []);

  return { rootNodeId, orgName, loading, error };
}

// The states that exist before there is an organisation to draw a shell
// around: booting, broken, empty, and seatless. They get a plain centred
// frame rather than a nav with nothing behind it.
function BootScreen({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-lg px-4 py-10 sm:px-6">{children}</div>;
}

// Every dead end here needs a way out. A phone that reached one of these
// screens as the wrong account could otherwise not even sign out of it, which
// is how a paired camera became a brick showing "not set up yet".
function SignOutEscape() {
  const { t } = useI18n();
  return (
    <div className="mt-4 flex justify-center">
      <Button
        variant="secondary"
        onClick={async () => {
          await supabase().auth.signOut();
          window.location.replace("/");
        }}
      >
        {t("common.sign_out")}
      </Button>
    </div>
  );
}

// The hub is for people. A camera is a machine account -- it holds no seat and
// no capability, so every query here returns nothing and the screens below
// would tell it the organisation does not exist. It belongs on its own screen.
function LeaveToCamera() {
  useEffect(() => {
    window.location.replace("/camera");
  }, []);
  return (
    <BootScreen>
      <ListSkeleton rows={2} />
    </BootScreen>
  );
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

  if (me.isLoading)
    return (
      <BootScreen>
        <ListSkeleton rows={2} label={t("common.loading")} />
      </BootScreen>
    );

  // Seeing no root node is not the same fact for everybody. An admin sees none
  // because there is none. Anyone else sees none because org_nodes is
  // RLS-filtered and theirs shows nothing -- telling them the business has not
  // been created is simply false, and it was the only thing on the screen.
  if (!me.data?.isAdmin) {
    return (
      <BootScreen>
        <Empty title={t("firstrun.no_access_title")} description={t("firstrun.no_access_body")} />
        <SignOutEscape />
      </BootScreen>
    );
  }

  return (
    <BootScreen>
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
    </BootScreen>
  );
}

// A signed-in account with no seat and no admin rights has nothing to do in the
// hub. It used to land in the full tab shell and hit an empty or failing page on
// every tab; now it gets one honest screen.
function NoSeat() {
  const { t } = useI18n();
  return (
    <BootScreen>
      <Empty title={t("noseat.title")} description={t("noseat.body")} />
      <SignOutEscape />
    </BootScreen>
  );
}

// The chart's tree can expand tall and wide enough that its own scrollbar
// drifts thousands of px below the fold if it just scrolls with the document.
// Only this route trades the normal document-scrolling shell for a bounded,
// self-scrolling pane -- everything else keeps scrolling the page like before.
const BOUNDED_CONTENT_ROUTES = ["/org/chart"];

function OrgRoutes() {
  const { t } = useI18n();
  const { rootNodeId, orgName, loading, error } = useRootNode();
  const { pathname } = useLocation();
  const isBounded = BOUNDED_CONTENT_ROUTES.includes(pathname);
  const me = useQuery({ queryKey: ["profile", "me"], queryFn: getMyProfile });
  const session = useQuery({ queryKey: ["profile", "session"], queryFn: loadProfile });

  if (session.data?.kind === "device") return <LeaveToCamera />;

  if (error) {
    return (
      <BootScreen>
        <ErrorState message={error} />
      </BootScreen>
    );
  }
  if (loading || me.isLoading) {
    return (
      <BootScreen>
        <ListSkeleton rows={4} />
      </BootScreen>
    );
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
      {/* The hash rides along: a pairing QR points at /org/cameras#pair=<code>
          and a bare string `to` would drop it on the way to the node route. */}
      <Route
        path="/org/cameras"
        element={
          <Navigate
            to={{ pathname: `/org/cameras/${rootNodeId}`, hash: window.location.hash }}
            replace
          />
        }
      />
      <Route path="/org/cameras/:nodeId" element={<CamerasPage />} />
      <Route
        path="/org/attendance"
        element={<Navigate to={`/org/attendance/${rootNodeId}`} replace />}
      />
      <Route path="/org/attendance/:nodeId" element={<AttendancePage />} />
      <Route path="/org/chart" element={<OrgChartPage />} />
      <Route path="/org/ranks" element={<RanksPage />} />
      <Route path="/org/jobs" element={<JobPostingsPage />} />
      <Route path="/org/jobs/:jobId/applications" element={<JobApplicationsPage />} />
      <Route path="/org/work" element={<WorkPage />} />
      <Route path="/org/notifications" element={<NotificationsPage />} />
      <Route path="/org/profile" element={<ProfilePage />} />
      <Route path="*" element={<Navigate to={`/org/node/${rootNodeId}`} replace />} />
    </Routes>
  );

  const displayName = me.data?.person?.display_name || me.data?.person?.full_name || t("nav.me");

  return (
    <OrgShell
      rootNodeId={rootNodeId}
      orgName={orgName}
      displayName={displayName}
      photoUrl={me.data?.person?.photo_url}
      bounded={isBounded}
    >
      {routes}
    </OrgShell>
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
        <BootScreen>
          <ErrorState message={configError} />
        </BootScreen>
      ) : user === "loading" ? (
        <BootScreen>
          <ListSkeleton rows={3} />
        </BootScreen>
      ) : user === "signed-out" ? (
        <Login />
      ) : (
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <OrgRouter>
              <OrgRoutes />
            </OrgRouter>
          </I18nProvider>
        </QueryClientProvider>
      )}
    </OrgErrorBoundary>
  );
}
