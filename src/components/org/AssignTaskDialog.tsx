import { useMutation, useQuery } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { endOfDayIso } from "../../lib/dates";
import { errorMessage } from "../../lib/errorMessage";
import { useI18n } from "../../lib/i18n";
import { type AssignableSeat, assignTask, listAssignableSeats } from "../../services/tasks";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Input, Label, Textarea } from "../ui/Input";
import { Select } from "../ui/Select";

interface Props {
  open: boolean;
  onClose: () => void;
  onAssigned: () => void;
  mySeats: AssignableSeat[];
}

// Work goes to a direct report, and the database decides who that is. This
// screen asks it rather than working it out from the tree, so the rule cannot
// drift between the two.
export function AssignTaskDialog(props: Props): JSX.Element | null {
  const { open, onClose, onAssigned, mySeats } = props;
  const { t } = useI18n();

  const [fromId, setFromId] = useState(mySeats[0]?.position_id ?? "");
  const [toId, setToId] = useState("");
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [weight, setWeight] = useState("1");
  const [dueAt, setDueAt] = useState("");
  const [error, setError] = useState<string | null>(null);

  const from = fromId || mySeats[0]?.position_id || "";

  const targets = useQuery({
    queryKey: ["work", "assignable", from],
    queryFn: () => listAssignableSeats(from),
    enabled: open && !!from,
  });

  // The dialog never unmounts -- `open` only gates its JSX -- so a cancelled
  // draft would still be sitting there, recipient and all, the next time it is
  // opened. Assigning work to the wrong seat is not a mistake you notice.
  const clear = () => {
    setToId("");
    setTitle("");
    setDetail("");
    setWeight("1");
    setDueAt("");
    setError(null);
  };

  const cancel = () => {
    clear();
    onClose();
  };

  const assign = useMutation({
    mutationFn: () =>
      assignTask({
        fromPositionId: from,
        toPositionId: toId,
        title,
        detail,
        weight: Number(weight) || 1,
        dueAt: dueAt ? endOfDayIso(dueAt) : null,
      }),
    onSuccess: () => {
      clear();
      onAssigned();
      onClose();
    },
    onError: (e) => setError(errorMessage(e, t("work.assign_failed"))),
  });

  if (!open) return null;

  const choices = targets.data ?? [];
  const ready = !!from && !!toId && title.trim().length > 0;

  return (
    <Dialog
      open={open}
      onClose={cancel}
      title={t("work.assign_title")}
      footer={
        <div className="flex gap-2">
          <Button variant="secondary" onClick={cancel}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!ready || assign.isPending} onClick={() => assign.mutate()}>
            {assign.isPending ? t("common.loading") : t("work.assign")}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {error && <Alert variant="error">{error}</Alert>}

        {mySeats.length > 1 && (
          <div>
            <Label htmlFor="work-from">{t("work.from_which_seat")}</Label>
            <Select
              id="work-from"
              value={from}
              onChange={(v) => {
                setFromId(v);
                setToId("");
              }}
              ariaLabel={t("work.from_which_seat")}
              options={mySeats.map((s) => ({
                value: s.position_id,
                label: `${s.title} — ${s.node_name}`,
              }))}
            />
          </div>
        )}

        <div>
          <Label htmlFor="work-to">{t("work.to_whom")}</Label>
          {targets.isLoading ? (
            <p className="text-sm text-ink-muted">{t("common.loading")}</p>
          ) : targets.isError ? (
            <p className="text-sm leading-relaxed text-danger-text">{t("work.reports_failed")}</p>
          ) : choices.length === 0 ? (
            <p className="text-sm leading-relaxed text-ink-muted">{t("work.no_reports")}</p>
          ) : (
            <Select
              id="work-to"
              value={toId}
              onChange={setToId}
              ariaLabel={t("work.to_whom")}
              options={[
                { value: "", label: t("work.pick_seat") },
                ...choices.map((s) => ({
                  value: s.position_id,
                  label: s.person_name
                    ? `${s.person_name} — ${s.title}`
                    : `${s.title} (${t("work.vacant")}) — ${s.node_name}`,
                })),
              ]}
            />
          )}
        </div>

        <div>
          <Label htmlFor="work-title">{t("work.what")}</Label>
          <Input
            id="work-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("work.what_placeholder")}
          />
        </div>

        <div>
          <Label htmlFor="work-detail">{t("work.detail")}</Label>
          <Textarea
            id="work-detail"
            rows={3}
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="work-due">{t("work.due_label")}</Label>
            <Input
              id="work-due"
              type="date"
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="work-weight">{t("work.weight_label")}</Label>
            <Input
              id="work-weight"
              type="number"
              min="0.5"
              step="0.5"
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
            />
          </div>
        </div>
        <p className="text-xs leading-relaxed text-ink-faint">{t("work.fixed_at_assignment")}</p>
      </div>
    </Dialog>
  );
}
