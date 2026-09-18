import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Navigate, BrowserRouter as OrgRouter, Route, Routes } from "react-router-dom";
import { errorMessage } from "../lib/errorMessage";
import { I18nProvider } from "../lib/i18n";
import { queryClient } from "../lib/query";
import { supabase } from "../lib/supabaseClient";
import Login from "../pages/Login";
import { CamerasPage } from "../pages/org/CamerasPage";
import { OrgErrorBoundary } from "./OrgErrorBoundary";

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

function OrgRoutes() {
  const { rootNodeId, error } = useRootNodeId();

  if (error) {
    return <div className="p-6 text-sm text-danger-text">{error}</div>;
  }
  if (!rootNodeId) {
    return <div className="p-6 text-sm text-ink-muted">Loading…</div>;
  }

  return (
    <Routes>
      <Route path="/org" element={<Navigate to={`/org/cameras/${rootNodeId}`} replace />} />
      <Route path="/org/cameras" element={<Navigate to={`/org/cameras/${rootNodeId}`} replace />} />
      <Route path="/org/cameras/:nodeId" element={<CamerasPage />} />
      <Route path="*" element={<Navigate to={`/org/cameras/${rootNodeId}`} replace />} />
    </Routes>
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
            <div className="min-h-screen bg-surface-sunken p-6">
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
