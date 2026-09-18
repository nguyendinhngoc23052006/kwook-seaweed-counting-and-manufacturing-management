import { format } from "date-fns";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "../../lib/i18n";
import { isOverdue, type TaskCard as Task } from "../../services/tasks";
import { Button } from "../ui/Button";
import { Pill } from "../ui/Pill";

interface Props {
  task: Task;
  // Which side of the task the reader is on. It changes which seat is worth
  // naming: on your own work you care who asked, on work you gave you care who
  // has it.
  side: "mine" | "given" | "node";
  busy?: boolean;
  onSubmit?: (task: Task) => void;
  onHandAcross?: (task: Task) => void;
  onAccept?: (task: Task) => void;
  onReject?: (task: Task) => void;
  onCancel?: (task: Task) => void;
}

function when(value: string, locale: string): string {
  const d = new Date(value);
  return format(d, locale === "en" ? "d MMM" : "d/M");
}

export function TaskCardView(props: Props): JSX.Element {
  const { task, side, busy } = props;
  const { t, locale } = useI18n();
  const late = isOverdue(task);
  const counterpart = side === "mine" ? task.by_seat : task.to_seat;

  return (
    <article className="rounded-lg border border-hairline bg-surface-raised p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="min-w-0 flex-1 font-medium leading-snug text-ink">{task.title}</h3>
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          {task.weight !== 1 && <Pill tone="accent">{t("work.weight", { n: task.weight })}</Pill>}
          {task.due_at && (
            <Pill tone={late ? "danger" : "neutral"}>
              {late
                ? t("work.overdue", { when: when(task.due_at, locale) })
                : t("work.due", { when: when(task.due_at, locale) })}
            </Pill>
          )}
          {task.state === "submitted" && <Pill tone="warning">{t("work.state_submitted")}</Pill>}
        </div>
      </div>

      {task.detail && (
        <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-ink-muted">
          {task.detail}
        </p>
      )}

      <p className="mt-2 text-xs text-ink-faint">
        {side === "mine"
          ? t("work.from_seat", { seat: counterpart.title })
          : t("work.with_seat", {
              seat: counterpart.person_name ?? counterpart.title,
            })}
        {" · "}
        <Link to={`/org/node/${counterpart.node_id}`} className="text-accent-text hover:underline">
          {counterpart.node_name}
        </Link>
      </p>

      {task.last_event?.note && (
        <p className="mt-2 rounded-md bg-surface-muted px-3 py-2 text-sm leading-relaxed text-ink-muted">
          {t(`work.event_${task.last_event.kind}`)}: {task.last_event.note}
        </p>
      )}

      {(task.can_submit || task.can_hand_across || task.can_decide || task.can_cancel) && (
        <div className="mt-3 flex flex-wrap gap-2">
          {task.can_submit && props.onSubmit && (
            <Button size="sm" disabled={busy} onClick={() => props.onSubmit?.(task)}>
              {t("work.submit")}
            </Button>
          )}
          {task.can_decide && props.onAccept && (
            <Button size="sm" disabled={busy} onClick={() => props.onAccept?.(task)}>
              {t("work.accept")}
            </Button>
          )}
          {task.can_decide && props.onReject && (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => props.onReject?.(task)}
            >
              {t("work.reject")}
            </Button>
          )}
          {task.can_hand_across && props.onHandAcross && (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => props.onHandAcross?.(task)}
            >
              {t("work.hand_across")}
            </Button>
          )}
          {task.can_cancel && props.onCancel && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => props.onCancel?.(task)}
            >
              {t("work.cancel")}
            </Button>
          )}
        </div>
      )}
    </article>
  );
}
