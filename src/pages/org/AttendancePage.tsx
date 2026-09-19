import { useMutation, useQuery } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";
import { Empty, ErrorState } from "../../components/ui/EmptyState";
import { Input, Label } from "../../components/ui/Input";
import { Pill } from "../../components/ui/Pill";
import { Section } from "../../components/ui/Section";
import { Select } from "../../components/ui/Select";
import { ListSkeleton } from "../../components/ui/Skeleton";
import { vietnamDayStartIso } from "../../lib/dates";
import { errorMessage } from "../../lib/errorMessage";
import { useT } from "../../lib/i18n";
import {
  type AttendanceRow,
  attendanceRowsToCsv,
  exportAttendance,
  fetchAttendanceReport,
} from "../../services/attendance";

import { capabilityReaches, getMyCapabilityReach } from "../../services/capabilities";
import { getOrgTree, isNodeEffectivelyActive, type OrgTreeNode } from "../../services/nodes";

const MAX_SPAN_DAYS = 62;

function toDateInputValue(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function mondayOfWeek(d: Date): Date {
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1;
  const monday = new Date(d);
  monday.setDate(d.getDate() - diff);
  return monday;
}

// UTC-anchored: only a day COUNT for the 62-day guard, so DST shifts a local
// calculation would hit are exactly what would make the count wrong.
function daysBetween(since: string, until: string): number {
  const [sy, sm, sd] = since.split("-").map(Number);
  const [uy, um, ud] = until.split("-").map(Number);
  const start = Date.UTC(sy ?? 0, (sm ?? 1) - 1, sd ?? 1);
  const end = Date.UTC(uy ?? 0, (um ?? 1) - 1, ud ?? 1);
  return Math.round((end - start) / 86_400_000);
}

function formatHm(totalSeconds: number): string {
  const totalMinutes = Math.round(totalSeconds / 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

// Same zone the report buckets days in, so a browser abroad still reads the
// clock the door actually punched.
function formatTimeVietnam(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function downloadCsv(rows: AttendanceRow[], fileName: string): void {
  const blob = new Blob([attendanceRowsToCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

function AttendanceTable({
  rows,
  t,
}: {
  rows: AttendanceRow[];
  t: ReturnType<typeof useT>;
}): JSX.Element {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[44rem] text-sm">
        <thead>
          <tr className="border-b border-hairline text-left text-ink-muted">
            <th className="whitespace-nowrap py-2 pr-3 font-medium">{t("attendance.col_name")}</th>
            <th className="whitespace-nowrap py-2 pr-3 font-medium">{t("attendance.col_code")}</th>
            <th className="whitespace-nowrap py-2 pr-3 font-medium">
              {t("attendance.col_missing")}
            </th>
            <th className="whitespace-nowrap py-2 pr-3 font-medium">{t("attendance.col_day")}</th>
            <th className="whitespace-nowrap py-2 pr-3 font-medium">
              {t("attendance.col_first_in")}
            </th>
            <th className="whitespace-nowrap py-2 pr-3 font-medium">
              {t("attendance.col_last_out")}
            </th>
            <th className="whitespace-nowrap py-2 pr-3 font-medium">{t("attendance.col_hours")}</th>
            <th className="whitespace-nowrap py-2 pr-3 font-medium">{t("attendance.col_ins")}</th>
            <th className="whitespace-nowrap py-2 pr-3 font-medium">{t("attendance.col_outs")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline bg-surface-raised text-ink">
          {rows.map((row) => {
            const missing = row.unpaired_ins + row.unpaired_outs;
            return (
              <tr key={`${row.person_id}-${row.day}`}>
                <td className="whitespace-nowrap py-2 pr-3">{row.full_name}</td>
                <td className="whitespace-nowrap py-2 pr-3">{row.employee_code}</td>
                <td className="whitespace-nowrap py-2 pr-3">
                  {missing > 0 ? (
                    <Pill tone="warning">{missing}</Pill>
                  ) : (
                    <span className="text-ink-muted">0</span>
                  )}
                </td>
                <td className="whitespace-nowrap py-2 pr-3">
                  {new Date(`${row.day}T00:00:00+07:00`).toLocaleDateString("vi-VN", {
                    timeZone: "Asia/Ho_Chi_Minh",
                  })}
                </td>
                <td className="whitespace-nowrap py-2 pr-3">{formatTimeVietnam(row.first_in)}</td>
                <td className="whitespace-nowrap py-2 pr-3">
                  {row.on_site ? (
                    <Pill tone="success">{t("attendance.on_site")}</Pill>
                  ) : (
                    formatTimeVietnam(row.last_out)
                  )}
                </td>
                <td className="whitespace-nowrap py-2 pr-3">{formatHm(row.seconds_on_site)}</td>
                <td className="whitespace-nowrap py-2 pr-3">{row.check_ins}</td>
                <td className="whitespace-nowrap py-2 pr-3">{row.check_outs}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Node-scoped like CamerasPage: view_attendance_below reaching this node
// gates both the report read and the export RPC server-side.
export function AttendancePage(): JSX.Element {
  const { nodeId } = useParams<{ nodeId: string }>();
  const navigate = useNavigate();
  const t = useT();

  const [since, setSince] = useState(() => toDateInputValue(mondayOfWeek(new Date())));
  const [until, setUntil] = useState(() => toDateInputValue(new Date()));
  const [submitted, setSubmitted] = useState<{ since: string; until: string } | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const reach = useQuery({ queryKey: ["org", "reach"], queryFn: getMyCapabilityReach });
  const canView =
    Boolean(nodeId) && capabilityReaches(reach.data, "view_attendance_below", nodeId ?? "");

  const tree = useQuery({ queryKey: ["org", "tree"], queryFn: getOrgTree, enabled: canView });
  const treeNodes: OrgTreeNode[] = tree.data ?? [];

  const rangeInvalid = until < since;
  const tooLong = daysBetween(since, until) + 1 > MAX_SPAN_DAYS;
  const guardBlocked = !since || !until || rangeInvalid || tooLong;

  const sinceIso = submitted ? vietnamDayStartIso(submitted.since) : null;
  const untilIso = submitted ? vietnamDayStartIso(submitted.until, 1) : null;

  const report = useQuery({
    queryKey: ["org", "attendance", nodeId, sinceIso, untilIso],
    queryFn: () => fetchAttendanceReport(nodeId ?? "", sinceIso ?? "", untilIso ?? ""),
    enabled: canView && Boolean(nodeId) && submitted !== null,
  });

  const exportMut = useMutation({
    mutationFn: () => exportAttendance(nodeId ?? "", sinceIso ?? "", untilIso ?? ""),
    onSuccess: (rows) => {
      setExportError(null);
      downloadCsv(rows, `attendance-${nodeId}-${submitted?.since}-${submitted?.until}.csv`);
    },
    onError: (e) => setExportError(errorMessage(e, t("attendance.export_failed"))),
  });

  if (reach.isLoading) return <ListSkeleton rows={3} label={t("common.loading")} />;
  if (!canView) {
    return <Empty title={t("attendance.not_yours")} description={t("attendance.not_yours_hint")} />;
  }

  const rows = report.data ?? [];
  const totalSeconds = rows.reduce((sum, r) => sum + r.seconds_on_site, 0);
  const peopleCount = new Set(rows.map((r) => r.person_id)).size;
  const missingDays = rows.filter((r) => r.unpaired_ins + r.unpaired_outs > 0).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-ink">{t("attendance.title")}</h1>
        <p className="text-sm text-ink-muted">{t("attendance.subtitle")}</p>
      </div>

      <Section title={t("attendance.unit")}>
        <div className="flex flex-wrap items-end gap-3 py-2">
          <div className="min-w-56 flex-1">
            <Select
              ariaLabel={t("attendance.unit")}
              searchable
              value={nodeId}
              onChange={(id) => navigate(`/org/attendance/${id}`)}
              options={treeNodes
                .filter((n) => capabilityReaches(reach.data, "view_attendance_below", n.id))
                .map((n) => ({
                  value: n.id,
                  label: isNodeEffectivelyActive(treeNodes, n.id)
                    ? n.name
                    : `${n.name} ${t("orgtree.archived_suffix")}`,
                }))}
            />
            {tree.isError && (
              <Alert variant="error">{errorMessage(tree.error, t("attendance.load_failed"))}</Alert>
            )}
          </div>
          <div>
            <Label htmlFor="attendance-since">{t("attendance.since")}</Label>
            <Input
              id="attendance-since"
              type="date"
              value={since}
              onChange={(e) => setSince(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="attendance-until">{t("attendance.until")}</Label>
            <Input
              id="attendance-until"
              type="date"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
            />
          </div>
          <Button disabled={guardBlocked} onClick={() => setSubmitted({ since, until })}>
            {t("attendance.load")}
          </Button>
          <Button
            variant="ghost"
            disabled={rows.length === 0 || exportMut.isPending}
            onClick={() => exportMut.mutate()}
          >
            {t("attendance.export")}
          </Button>
        </div>
        {rangeInvalid ? (
          <Alert variant="warning">{t("attendance.range_inverted")}</Alert>
        ) : tooLong ? (
          <Alert variant="warning">{t("attendance.too_long")}</Alert>
        ) : null}
        {exportError && <Alert variant="error">{exportError}</Alert>}
      </Section>

      {submitted === null ? (
        <Empty title={t("attendance.pick_range")} />
      ) : report.isLoading ? (
        <ListSkeleton rows={4} label={t("common.loading")} />
      ) : report.isError ? (
        <ErrorState
          message={errorMessage(report.error, t("attendance.load_failed"))}
          action={<Button onClick={() => report.refetch()}>{t("common.retry")}</Button>}
        />
      ) : rows.length === 0 ? (
        <Empty title={t("attendance.empty")} />
      ) : (
        <div className="space-y-3">
          <AttendanceTable rows={rows} t={t} />
          <div className="space-y-1 text-sm">
            <p className="text-ink">
              {t("attendance.total_hours")}: {formatHm(totalSeconds)} ·{" "}
              {t("attendance.people", { count: peopleCount })} ·{" "}
              {t("attendance.days_missing", { count: missingDays })}
            </p>
            <p className="text-ink-muted">{t("attendance.missing_hint")}</p>
          </div>
        </div>
      )}
    </div>
  );
}
