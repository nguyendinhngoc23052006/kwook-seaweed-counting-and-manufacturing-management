import { QueryClientProvider } from "@tanstack/react-query";
import type { JSX } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { I18nProvider } from "../lib/i18n";
import { queryClient } from "../lib/query";
import { OrgErrorBoundary } from "../org/OrgErrorBoundary";
import { ApplyPage } from "../pages/public/ApplyPage";
import { HomePage } from "../pages/public/HomePage";
import { JobDetailPage } from "../pages/public/JobDetailPage";
import { PublicLayout } from "./PublicLayout";

// The careers site: no auth gate at all, because the person reading it does
// not have an account yet. A separate sibling from OrgApp for the same reason
// OrgApp is separate from the device/wall app -- three audiences, three gates.
export function PublicJobsApp(): JSX.Element {
  return (
    <OrgErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/" element={<PublicLayout />}>
                <Route index element={<HomePage />} />
                <Route path="jobs/:jobId" element={<JobDetailPage />} />
                <Route path="jobs/:jobId/apply" element={<ApplyPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </I18nProvider>
      </QueryClientProvider>
    </OrgErrorBoundary>
  );
}
