import { useQuery } from "@tanstack/react-query";
import {
  Bell,
  Briefcase,
  Building2,
  Camera,
  ChevronsUpDown,
  ClipboardList,
  Clock,
  LogOut,
  Menu,
  Network,
  User,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Avatar, AvatarFallback, AvatarImage, initialsOf } from "../components/ui/Avatar";
import { Button } from "../components/ui/Button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/DropdownMenu";
import { Pill } from "../components/ui/Pill";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "../components/ui/Sheet";
import { useI18n } from "../lib/i18n";
import { supabase } from "../lib/supabaseClient";
import { cn } from "../lib/utils";
import { unreadNotificationCount } from "../services/notifications";

async function signOut() {
  await supabase().auth.signOut();
  window.location.reload();
}

interface NavItem {
  to: string;
  match: string;
  label: string;
  icon: typeof Bell;
  badge?: number;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

// Eight equal tabs in one row said everything was equally important and that
// nothing belonged to anything. Three named groups say what the hub is for:
// the shape of the company, what runs on the floor, and what you owe someone.
function useNavGroups(rootNodeId: string, unread: number): NavGroup[] {
  const { t } = useI18n();
  return [
    {
      label: t("nav.group_org"),
      items: [
        {
          to: `/org/node/${rootNodeId}`,
          match: "/org/node",
          label: t("nav.tree"),
          icon: Building2,
        },
        { to: "/org/chart", match: "/org/chart", label: t("nav.chart"), icon: Network },
      ],
    },
    {
      label: t("nav.group_floor"),
      items: [
        {
          to: `/org/cameras/${rootNodeId}`,
          match: "/org/cameras",
          label: t("nav.cameras"),
          icon: Camera,
        },
        {
          to: `/org/attendance/${rootNodeId}`,
          match: "/org/attendance",
          label: t("nav.attendance"),
          icon: Clock,
        },
      ],
    },
    {
      label: t("nav.group_work"),
      items: [
        { to: "/org/work", match: "/org/work", label: t("nav.work"), icon: ClipboardList },
        { to: "/org/jobs", match: "/org/jobs", label: t("nav.jobs"), icon: Briefcase },
        {
          to: "/org/notifications",
          match: "/org/notifications",
          label: t("nav.notifications"),
          icon: Bell,
          badge: unread,
        },
      ],
    },
  ];
}

function NavLink({ item, onNavigate }: { item: NavItem; onNavigate?: () => void }) {
  const { pathname } = useLocation();
  const active = pathname.startsWith(item.match);
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40",
        active
          ? "bg-primary-subtle text-primary-text"
          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      <Icon className={cn("size-4 shrink-0", active && "text-primary")} />
      <span className="flex-1 truncate">{item.label}</span>
      {item.badge ? (
        <Pill tone="danger" className="tabular-nums">
          {item.badge > 99 ? "99+" : item.badge}
        </Pill>
      ) : null}
    </Link>
  );
}

function NavGroups({ groups, onNavigate }: { groups: NavGroup[]; onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-5">
      {groups.map((group) => (
        <div key={group.label}>
          <p className="mb-1 px-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {group.label}
          </p>
          <div className="flex flex-col gap-0.5">
            {group.items.map((item) => (
              <NavLink key={item.to} item={item} onNavigate={onNavigate} />
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}

function OrgMark({ orgName }: { orgName: string }) {
  return (
    <div className="flex items-center gap-2.5 px-3">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-sm font-semibold text-primary-foreground">
        {orgName.trim().charAt(0).toUpperCase() || "K"}
      </div>
      <span className="truncate font-display text-base font-semibold text-foreground">
        {orgName}
      </span>
    </div>
  );
}

function AccountMenu({ name, photoUrl }: { name: string; photoUrl?: string | null }) {
  const { t, locale, setLocale } = useI18n();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2.5 px-2"
          aria-label={t("nav.account_menu")}
        >
          <Avatar className="size-8">
            {photoUrl && <AvatarImage src={photoUrl} alt="" />}
            <AvatarFallback>{initialsOf(name)}</AvatarFallback>
          </Avatar>
          <span className="min-w-0 flex-1 truncate text-left text-sm font-medium">{name}</span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>{name}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/org/profile">
            <User />
            {t("nav.me")}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setLocale(locale === "vi" ? "en" : "vi")}>
          <span className="w-4 text-center text-xs font-semibold">
            {locale === "vi" ? "EN" : "VI"}
          </span>
          {locale === "vi" ? "English" : "Tiếng Việt"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="danger" onSelect={signOut}>
          <LogOut />
          {t("common.sign_out")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function OrgShell({
  rootNodeId,
  orgName,
  displayName,
  photoUrl,
  bounded,
  children,
}: {
  rootNodeId: string;
  orgName: string;
  displayName: string;
  photoUrl?: string | null;
  bounded: boolean;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Polled, not live: an unread count that is a minute stale costs nothing,
  // where a realtime subscription per tab costs a connection per tab.
  const unread = useQuery({
    queryKey: ["notifications", "unread-count"],
    queryFn: unreadNotificationCount,
    refetchInterval: 60_000,
  });

  const groups = useNavGroups(rootNodeId, unread.data ?? 0);

  return (
    <div className="min-h-dvh bg-background lg:grid lg:grid-cols-[17rem_1fr]">
      <aside className="sticky top-0 hidden h-dvh flex-col gap-6 border-r border-border bg-card py-4 lg:flex">
        <OrgMark orgName={orgName} />
        <div className="min-h-0 flex-1 overflow-y-auto px-2">
          <NavGroups groups={groups} />
        </div>
        <div className="border-t border-border px-2 pt-3">
          <AccountMenu name={displayName} photoUrl={photoUrl} />
        </div>
      </aside>

      <div className={cn("flex min-w-0 flex-col", bounded && "h-dvh overflow-hidden")}>
        <header className="sticky top-0 z-30 flex min-h-14 items-center gap-2 border-b border-border bg-card/90 px-3 backdrop-blur lg:hidden">
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t("nav.open_menu")}>
                <Menu />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" closeLabel={t("common.close")} className="py-4">
              <SheetTitle className="sr-only">{t("nav.open_menu")}</SheetTitle>
              <OrgMark orgName={orgName} />
              <div className="mt-6 min-h-0 flex-1 overflow-y-auto px-2">
                <NavGroups groups={groups} onNavigate={() => setMobileOpen(false)} />
              </div>
              <div className="border-t border-border px-2 pt-3">
                <AccountMenu name={displayName} photoUrl={photoUrl} />
              </div>
            </SheetContent>
          </Sheet>
          <span className="truncate font-display text-base font-semibold">{orgName}</span>
          <Button
            variant="ghost"
            size="icon-sm"
            asChild
            className="relative ml-auto"
            aria-label={t("nav.notifications")}
          >
            <Link to="/org/notifications">
              <Bell />
              {(unread.data ?? 0) > 0 && (
                <span className="absolute right-2 top-2 size-2 rounded-full bg-destructive" />
              )}
            </Link>
          </Button>
        </header>

        <main
          className={cn(
            "mx-auto w-full max-w-6xl flex-1 px-4 py-5 sm:px-6",
            bounded && "flex min-h-0 flex-col overflow-y-auto",
          )}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
