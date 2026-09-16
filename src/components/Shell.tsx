import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import type { Profile } from "../lib/session";
import { supabase } from "../lib/supabaseClient";
import { useOnline } from "../lib/useOnline";

const ROLE_RANK: Record<string, number> = {
  pending: 0,
  viewer: 1,
  supervisor: 2,
  manager: 3,
  owner: 4,
};

// Mirrors the database's role_rank, including its fail-closed default: a role
// this build has never heard of ranks 0 and is shown nothing but the wall.
export function atLeast(role: string, min: string): boolean {
  return (ROLE_RANK[role] ?? 0) >= (ROLE_RANK[min] ?? 0);
}

interface NavItem {
  key: string;
  label: string;
  href: string;
  min: string;
}

const NAV: NavItem[] = [
  { key: "wall", label: "Wall", href: "/wall", min: "viewer" },
  { key: "stations", label: "Stations", href: "/stations", min: "manager" },
  { key: "cameras", label: "Cameras", href: "/admin", min: "owner" },
];

async function signOut() {
  await supabase().auth.signOut();
  window.location.reload();
}

export default function Shell({
  profile,
  active,
  children,
}: {
  profile: Profile;
  active: string;
  children: ReactNode;
}) {
  const online = useOnline();
  const items = NAV.filter((item) => atLeast(profile.role, item.min));

  return (
    <div className="app">
      <header className="appbar">
        <span className="appbar__brand">Kwook Line Vision</span>
        <nav className="appbar__nav">
          {/* `active` still matters: /station/:id has no nav item of its own and
              passes active="wall" so the Wall tab stays lit on a detail page. */}
          {items.map((item) => (
            <NavLink
              key={item.key}
              to={item.href}
              className={({ isActive }) =>
                isActive || item.key === active ? "navlink navlink--active" : "navlink"
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <span className="appbar__spacer" />
        <span className="muted truncate">{profile.display_name}</span>
        <button type="button" className="btn btn--ghost btn--sm" onClick={signOut}>
          Sign out
        </button>
      </header>
      {online ? null : (
        <div className="banner banner--warn">
          You are offline. Cameras keep counting and will sync when the connection returns.
        </div>
      )}
      <main className="wrap">{children}</main>
    </div>
  );
}
