import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { errorMessage } from "../../lib/errorMessage";
import { useI18n } from "../../lib/i18n";
import {
  type AttendanceRow,
  addAttendancePunch,
  listAttendancePunches,
  listVoidedPunches,
  voidAttendancePunch,
} from "../../services/attendance";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Empty } from "../ui/EmptyState";
import { Input, Label } from "../ui/Input";
import { Pill } from "../ui/Pill";
import { Select } from "../ui/Select";
import { ListSkeleton } from "../ui/Skeleton";

// The report's own day boundary. A punch at 00:30 Vietnam time belongs to that
// Vietnam day, not to the UTC one the browser would pick.
function vietnamDayOf(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Ho_Chi_Minh",
  });
}

// A datetime-local value is wall-clock with no zone; the punch must be stamped
// in Vietnam time whatever the browser's own zone is, so the offset is applied
// explicitly rather than trusting new Date(value).
function vietnamIsoFrom(day: string, time: string): string {
  return new Date(`${day}T${time}:00+07:00`).toISOString();
}

export function AttendanceCorrectionDialog({
  open,
  onClose,
  row,
  nodeId,
  sinceIso,
  untilIso,
}: {
  open: boolean;
  onClose: () => void;
  row: AttendanceRow;
  nodeId: string;
  sinceIso: string;
  untilIso: string;
}): JSX.Element | null {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<"check_in" | "check_out">("check_in");
  const [time, setTime] = useState("08:00");
  const [reason, setReason] = useState("");
  const [voidingId, setVoidingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const punches = useQuery({
    queryKey: ["org", "attendance-punches", nodeId, sinceIso, untilIso],
    queryFn: () => listAttendancePunches(nodeId, sinceIso, untilIso),
    enabled: open,
  });
  const voided = useQuery({
    queryKey: ["org", "attendance-voided", nodeId, sinceIso, untilIso],
    queryFn: () => listVoidedPunches(nodeId, sinceIso, untilIso),
    enabled: open,
  });

  const mine = (punches.data ?? []).filter(
    (p) => p.person_id === row.person_id && vietnamDayOf(p.at) === row.day,
  );
  const myVoided = (voided.data ?? []).filter(
    (v) => v.person_id === row.person_id && vietnamDayOf(v.at) === row.day,
  );

  const refresh = () => {
    setReason("");
    setError(null);
    setVoidingId(null);
    queryClient.invalidateQueries({ queryKey: ["org", "attendance-punches"] });
    queryClient.invalidateQueries({ queryKey: ["org", "attendance-voided"] });
    queryClient.invalidateQueries({ queryKey: ["org", "attendance"] });
  };

  const add = useMutation({
    mutationFn: () =>
      addAttendancePunch({
        personId: row.person_id,
        nodeId,
        kind,
        at: vietnamIsoFrom(row.day, time),
        reason,
      }),
    onSuccess: refresh,
    onError: (e) => setError(errorMessage(e, t("correction.failed"))),
  });

  const voidPunch = useMutation({
    mutationFn: (eventId: string) =>
      voidAttendancePunch({ personId: row.person_id, nodeId, eventId, reason }),
    onSuccess: refresh,
    onError: (e) => setError(errorMessage(e, t("correction.failed"))),
  });

  const busy = add.isPending || voidPunch.isPending;
  const reasonOk = reason.trim().length >= 3;

  if (!open) return null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("correction.title", { name: row.full_name })}
      description={t("correction.subtitle", { day: row.day })}
      footer={
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          {t("common.close")}
        </Button>
      }
    >
      <div className="space-y-4">
        {error && <Alert variant="error">{error}</Alert>}

        {/* One reason box for both actions: every correction must say why,
            and the database refuses anything under three characters. */}
        <div>
          <Label htmlFor="correction-reason">{t("correction.reason")}</Label>
          <Input
            id="correction-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t("correction.reason_placeholder")}
            disabled={busy}
          />
        </div>

        <section>
          <h3 className="mb-2 text-sm font-medium text-foreground">{t("correction.punches")}</h3>
          {punches.isLoading ? (
            <ListSkeleton rows={2} />
          ) : mine.length === 0 ? (
            <Empty title={t("correction.no_punches")} />
          ) : (
            <ul className="divide-y divide-border">
              {mine.map((punch) => (
                <li
                  key={punch.event_id ?? `adj-${punch.adjustment_id}`}
                  className="flex flex-wrap items-center gap-2 py-2"
                >
                  <span className="font-medium tabular-nums">{timeOf(punch.at)}</span>
                  <Pill tone={punch.kind === "check_in" ? "success" : "neutral"}>
                    {t(`correction.${punch.kind}`)}
                  </Pill>
                  {punch.source === "added" && (
                    <Pill tone="warning">{t("correction.added_by_hand")}</Pill>
                  )}
                  {punch.reason && (
                    <span className="text-xs text-muted-foreground">{punch.reason}</span>
                  )}
                  {/* Only a camera punch can be voided: an added one is itself
                      an adjustment, and the ledger is append-only. */}
                  {punch.event_id && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto"
                      disabled={busy || !reasonOk}
                      onClick={() => {
                        setVoidingId(punch.event_id);
                        voidPunch.mutate(punch.event_id as string);
                      }}
                    >
                      {voidingId === punch.event_id && voidPunch.isPending
                        ? t("common.loading")
                        : t("correction.void")}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {!reasonOk && mine.length > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">{t("correction.reason_first")}</p>
          )}
        </section>

        {myVoided.length > 0 && (
          <section>
            <h3 className="mb-2 text-sm font-medium text-foreground">{t("correction.voided")}</h3>
            <ul className="divide-y divide-border">
              {myVoided.map((v) => (
                <li key={v.event_id} className="flex flex-wrap items-center gap-2 py-2">
                  <span className="tabular-nums text-muted-foreground line-through">
                    {timeOf(v.at)}
                  </span>
                  <Pill tone="danger">{t(`correction.${v.kind}`)}</Pill>
                  <span className="text-xs text-muted-foreground">{v.reason}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="border-t border-border pt-4">
          <h3 className="mb-2 text-sm font-medium text-foreground">{t("correction.add")}</h3>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-40 flex-1">
              <Label htmlFor="correction-kind">{t("correction.kind")}</Label>
              <Select
                id="correction-kind"
                value={kind}
                onChange={(v) => setKind(v as "check_in" | "check_out")}
                ariaLabel={t("correction.kind")}
                disabled={busy}
                options={[
                  { value: "check_in", label: t("correction.check_in") },
                  { value: "check_out", label: t("correction.check_out") },
                ]}
              />
            </div>
            <div className="min-w-32 flex-1">
              <Label htmlFor="correction-time">{t("correction.time")}</Label>
              <Input
                id="correction-time"
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                disabled={busy}
              />
            </div>
            <Button disabled={busy || !reasonOk || !time} onClick={() => add.mutate()}>
              {add.isPending ? t("common.loading") : t("correction.add_submit")}
            </Button>
          </div>
        </section>
      </div>
    </Dialog>
  );
}
