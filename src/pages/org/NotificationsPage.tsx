import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";
import { Empty, ErrorState } from "../../components/ui/EmptyState";
import { Pill } from "../../components/ui/Pill";
import { Section } from "../../components/ui/Section";
import { ListSkeleton } from "../../components/ui/Skeleton";
import { errorMessage } from "../../lib/errorMessage";
import { useT } from "../../lib/i18n";
import {
  listNotifications,
  markNotificationRead,
  type Notification,
  type NotificationKind,
} from "../../services/notifications";

// org_notifications() fixes p_limit at 50 server-side (see
// services/notifications.ts) -- this mirrors that fixed page size rather than
// inventing a page-size control the RPC has no parameter for.
const NOTIFICATIONS_PAGE = 50;

const TONE: Record<NotificationKind, "neutral" | "accent" | "success" | "warning" | "danger"> = {
  task_assigned: "accent",
  task_submitted: "accent",
  task_accepted: "success",
  task_rejected: "danger",
  task_handed_across: "accent",
  task_commented: "accent",
  capability_changed: "neutral",
};

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

// Every payload shape is written by one specific trigger in
// supabase/migrations/20260923030000_notifications.sql; this reads only the
// fields that trigger actually writes for the given kind, by shape rather
// than by a discriminated-union type the payload's `jsonb` column can't
// enforce.
function Detail({
  notif,
  t,
}: {
  notif: Notification;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const p = notif.payload;
  const title = str(p.title);
  const note = str(p.note);
  const body = str(p.body);

  if (notif.kind === "capability_changed") {
    const key = str(p.capability_key);
    const granted = typeof p.granted === "boolean" ? p.granted : undefined;
    const reason = str(p.reason);
    return (
      <>
        {key && (
          <p className="mt-1 text-sm text-ink-muted">
            {t(`capability.${key}`)}
            {granted !== undefined &&
              ` — ${granted ? t("notifications.capability_granted") : t("notifications.capability_revoked")}`}
          </p>
        )}
        {reason && (
          <p className="mt-1 text-xs text-ink-faint">
            {t("notifications.reason_label", { reason })}
          </p>
        )}
      </>
    );
  }

  return (
    <>
      {title && <p className="mt-1 text-sm text-ink-muted">{title}</p>}
      {notif.kind === "task_commented" && body && (
        <p className="mt-1 text-sm text-ink-muted">{body}</p>
      )}
      {note && <p className="mt-1 text-xs text-ink-faint">{note}</p>}
    </>
  );
}

// The other side of every seat that just changed: work assigned to you,
// bounced back to you, handed to you, commented on, or a capability of yours
// that just moved. No "mark all read" here -- org_mark_notification_read()
// only takes one id at a time, the same posture as task_comments' RPC-only
// doors.
export function NotificationsPage(): JSX.Element {
  const t = useT();
  const queryClient = useQueryClient();
  const [pages, setPages] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const before = pages[pages.length - 1];
  const notifications = useQuery({
    queryKey: ["notifications", "list", before ?? null],
    queryFn: () => listNotifications(before),
  });

  const markReadMutation = useMutation({
    mutationFn: (id: string) => markNotificationRead(id),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
    },
    onError: (e) => setError(errorMessage(e, t("notifications.action_failed"))),
  });

  if (notifications.isLoading) {
    return <ListSkeleton rows={4} label={t("notifications.loading")} />;
  }
  if (notifications.isError) {
    return (
      <ErrorState
        message={errorMessage(notifications.error, t("notifications.load_failed"))}
        action={<Button onClick={() => notifications.refetch()}>{t("common.retry")}</Button>}
      />
    );
  }

  const rows = notifications.data ?? [];
  const more = rows.length === NOTIFICATIONS_PAGE;
  const lastCreatedAt = rows.at(-1)?.created_at;
  const unreadCount = rows.filter((n) => !n.read_at).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink">{t("notifications.title")}</h1>
          <p className="text-sm leading-relaxed text-ink-muted">{t("notifications.subtitle")}</p>
        </div>
        {unreadCount > 0 && (
          <Pill tone="accent">{t("notifications.unread_n", { n: unreadCount })}</Pill>
        )}
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      {rows.length === 0 ? (
        <Empty title={t("notifications.empty")} description={t("notifications.empty_hint")} />
      ) : (
        <Section title={t("notifications.all")} description={t("notifications.all_hint")}>
          <div className="space-y-3 py-3">
            {rows.map((notif) => (
              <article
                key={notif.id}
                className={`rounded-lg border border-hairline bg-surface-raised p-4 ${
                  notif.read_at ? "opacity-60" : "border-accent-subtle bg-accent-subtle"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Pill tone={TONE[notif.kind]}>{t(`notifications.kind_${notif.kind}`)}</Pill>
                      <p className="text-xs text-ink-faint">
                        {new Date(notif.created_at).toLocaleString()}
                      </p>
                    </div>
                    <Detail notif={notif} t={t} />
                  </div>
                  {!notif.read_at && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={markReadMutation.isPending}
                      onClick={() => markReadMutation.mutate(notif.id)}
                    >
                      {t("notifications.mark_read")}
                    </Button>
                  )}
                </div>
              </article>
            ))}
          </div>
        </Section>
      )}

      {(more || pages.length > 0) && (
        <div className="flex flex-wrap gap-2">
          {pages.length > 0 && (
            <Button variant="secondary" onClick={() => setPages(pages.slice(0, -1))}>
              {t("notifications.previous")}
            </Button>
          )}
          {more && lastCreatedAt && (
            <Button variant="secondary" onClick={() => setPages([...pages, lastCreatedAt])}>
              {t("notifications.next")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
