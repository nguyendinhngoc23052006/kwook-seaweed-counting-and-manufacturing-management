import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { errorMessage } from "../../lib/errorMessage";
import { useT } from "../../lib/i18n";
import {
  createCameraStation,
  listCameraStations,
  updateCameraStation,
} from "../../services/cameras";
import type { CameraDeviceRole } from "../../types/camera";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Empty } from "../ui/EmptyState";
import { Input, Label } from "../ui/Input";
import { ListRow, ListRows } from "../ui/ListRow";
import { Pill } from "../ui/Pill";
import { Section } from "../ui/Section";
import { Select } from "../ui/Select";
import { ListSkeleton } from "../ui/Skeleton";

const KINDS: CameraDeviceRole[] = ["counting", "compliance", "overview", "provisioning"];

// camera_stations has had full write policies and grants since it was created
// and nothing above the database ever used them, so a camera could never be
// given a physical placement to point at. A station is where a camera IS;
// without one, a device's placement is a name and nothing else.
export function CameraStationsPanel({
  nodeId,
  canManage,
}: {
  nodeId: string;
  canManage: boolean;
}): JSX.Element {
  const t = useT();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [line, setLine] = useState("");
  const [kind, setKind] = useState<CameraDeviceRole>("counting");
  const [error, setError] = useState<string | null>(null);

  const stations = useQuery({
    queryKey: ["org", "camera-stations", nodeId],
    queryFn: () => listCameraStations(nodeId),
  });

  const refresh = () => {
    setError(null);
    queryClient.invalidateQueries({ queryKey: ["org", "camera-stations", nodeId] });
  };

  const create = useMutation({
    mutationFn: () => createCameraStation({ nodeId, name, line, kind }),
    onSuccess: () => {
      setName("");
      setLine("");
      refresh();
    },
    onError: (e) => setError(errorMessage(e, t("station.create_failed"))),
  });

  const toggle = useMutation({
    mutationFn: (input: { id: string; active: boolean }) =>
      updateCameraStation(input.id, { active: input.active }),
    onSuccess: refresh,
    onError: (e) => setError(errorMessage(e, t("station.update_failed"))),
  });

  const rows = stations.data ?? [];

  return (
    <Section title={t("station.title")} description={t("station.hint")}>
      <div className="space-y-4 py-2">
        {error && <Alert variant="error">{error}</Alert>}

        {stations.isLoading ? (
          <ListSkeleton rows={2} />
        ) : rows.length === 0 ? (
          <Empty title={t("station.empty")} description={t("station.empty_hint")} />
        ) : (
          <ListRows>
            {rows.map((s) => (
              <ListRow
                key={s.id}
                title={s.name}
                subtitle={`${s.line} · ${t(`device.role_${s.kind}`)}`}
                meta={!s.active ? <Pill tone="neutral">{t("station.retired")}</Pill> : undefined}
                trailing={
                  canManage ? (
                    <Button
                      size="sm"
                      variant={s.active ? "ghost" : "secondary"}
                      disabled={toggle.isPending}
                      onClick={() => toggle.mutate({ id: s.id, active: !s.active })}
                    >
                      {s.active ? t("station.retire") : t("station.restore")}
                    </Button>
                  ) : undefined
                }
              />
            ))}
          </ListRows>
        )}

        {canManage && (
          <div className="flex flex-wrap items-end gap-2 border-t border-border pt-4">
            <div className="min-w-40 flex-1">
              <Label htmlFor="station-name">{t("station.name")}</Label>
              <Input
                id="station-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={create.isPending}
              />
            </div>
            <div className="min-w-32 flex-1">
              <Label htmlFor="station-line">{t("station.line")}</Label>
              <Input
                id="station-line"
                value={line}
                onChange={(e) => setLine(e.target.value)}
                disabled={create.isPending}
              />
            </div>
            <div className="min-w-40 flex-1">
              <Label htmlFor="station-kind">{t("station.kind")}</Label>
              <Select
                id="station-kind"
                value={kind}
                onChange={(v) => setKind(v as CameraDeviceRole)}
                ariaLabel={t("station.kind")}
                disabled={create.isPending}
                options={KINDS.map((k) => ({ value: k, label: t(`device.role_${k}`) }))}
              />
            </div>
            <Button
              disabled={create.isPending || !name.trim() || !line.trim()}
              onClick={() => create.mutate()}
            >
              {create.isPending ? t("common.loading") : t("station.add")}
            </Button>
          </div>
        )}
      </div>
    </Section>
  );
}
