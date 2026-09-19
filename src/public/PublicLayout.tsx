import { type JSX, useEffect, useState } from "react";
import { Link, Outlet } from "react-router-dom";
import { Select } from "../components/ui/Select";
import { useI18n } from "../lib/i18n";
import { loadProfile } from "../lib/session";
import { supabase } from "../lib/supabaseClient";

// The unauthenticated shell. Deliberately NOT the employee Shell: this has no
// tabs, no node context and no sign-out, because the person reading it does not
// work here yet. The only way in is the one link at the top right.
export function PublicLayout(): JSX.Element {
  const { t, locale, setLocale } = useI18n();
  // Not just WHETHER someone is signed in, but WHAT. A camera is a machine
  // account: offering it "go to your workspace" sent it to a hub it can see
  // nothing in, and the only session on that browser was the camera's -- so
  // the person holding the phone could not get back to being themselves.
  // A device gets its own screen and a way out instead.
  const [who, setWho] = useState<"anonymous" | "person" | "camera">("anonymous");

  useEffect(() => {
    void (async () => {
      const profile = await loadProfile().catch(() => null);
      if (!profile) return setWho("anonymous");
      setWho(profile.kind === "device" ? "camera" : "person");
    })();
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
              href={who === "camera" ? "/camera" : who === "person" ? "/org" : "/login"}
              className="inline-flex min-h-11 shrink-0 items-center rounded-lg px-3 text-sm font-medium text-primary-text hover:bg-surface-muted"
            >
              {who === "camera"
                ? t("public.open_camera")
                : who === "person"
                  ? t("public.go_to_workspace")
                  : t("public.staff_sign_in")}
            </a>
            {/* The way back to being yourself on a phone that became a camera.
                Without it the camera's session owns the browser and there is
                nothing on any screen that can end it. */}
            {who === "camera" && (
              <button
                type="button"
                onClick={async () => {
                  await supabase().auth.signOut();
                  window.location.replace("/login");
                }}
                className="inline-flex min-h-11 shrink-0 items-center rounded-lg px-3 text-sm font-medium text-ink-faint hover:bg-surface-muted"
              >
                {t("common.sign_out")}
              </button>
            )}
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
