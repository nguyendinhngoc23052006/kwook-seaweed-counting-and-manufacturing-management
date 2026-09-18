import { type JSX, useEffect, useState } from "react";
import { Link, Outlet } from "react-router-dom";
import { Select } from "../components/ui/Select";
import { useI18n } from "../lib/i18n";
import { supabase } from "../lib/supabaseClient";

// The unauthenticated shell. Deliberately NOT the employee Shell: this has no
// tabs, no node context and no sign-out, because the person reading it does not
// work here yet. The only way in is the one link at the top right.
export function PublicLayout(): JSX.Element {
  const { t, locale, setLocale } = useI18n();
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    supabase()
      .auth.getUser()
      .then(({ data }) => setSignedIn(!!data.user));
  }, []);

  return (
    <div className="flex min-h-screen w-full flex-col overflow-x-hidden bg-brand-cream-light">
      <header className="border-b border-brand-hairline bg-surface-raised">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-4 py-3">
          <Link to="/" className="shrink-0 font-display text-base font-semibold text-ink">
            Kwook
          </Link>
          <div className="flex items-center gap-2">
            <Select
              value={locale}
              onChange={setLocale}
              options={[
                { value: "vi", label: "Tiếng Việt" },
                { value: "en", label: "English" },
              ]}
              ariaLabel={t("profile.locale")}
              className="w-32"
            />
            {/* A plain anchor, not <Link>: this section is its own sibling
                router (see PublicJobsApp), so leaving it needs a real
                navigation for App.tsx to re-evaluate which app owns the path. */}
            <a
              href={signedIn ? "/org" : "/login"}
              className="inline-flex min-h-11 shrink-0 items-center rounded-lg px-3 text-sm font-medium text-accent-text hover:bg-surface-muted"
            >
              {signedIn ? t("public.go_to_workspace") : t("public.staff_sign_in")}
            </a>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:py-12">
        <Outlet />
      </main>

      <footer className="border-t border-brand-hairline bg-surface-raised">
        <div className="mx-auto w-full max-w-5xl px-4 py-6 text-sm leading-relaxed text-ink-muted">
          {t("public.footer")}
        </div>
      </footer>
    </div>
  );
}
