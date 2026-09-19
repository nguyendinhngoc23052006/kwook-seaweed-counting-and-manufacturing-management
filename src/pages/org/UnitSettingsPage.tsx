import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";
import { Card, CardTitle } from "../../components/ui/Card";
import { ErrorState } from "../../components/ui/EmptyState";
import { Input, Label } from "../../components/ui/Input";
import { Pill } from "../../components/ui/Pill";
import { Section } from "../../components/ui/Section";
import { Select } from "../../components/ui/Select";
import { ListSkeleton } from "../../components/ui/Skeleton";
import { errorMessage } from "../../lib/errorMessage";
import { useI18n } from "../../lib/i18n";
import { archiveEntity } from "../../services/archive";
import { getMyCapabilityReach } from "../../services/capabilities";
import {
  type CapabilityKey,
  findNode,
  getOrgTree,
  listNodeNatures,
  renameNode,
  setNodeActive,
  setNodeNature,
} from "../../services/nodes";

// Display-only formatting for a capability key like "assign_work_down" --
// "Assign work down". Not a translation: fifteen capability keys sharing one
// vocabulary don't earn fifteen i18n rows, and this list is read here and
// nowhere else.
function humanize(key: CapabilityKey): string {
  return key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

// What a unit's settings still are once join codes and geofences went with the
// retail app: what this unit is called, what kind of place it is, and whether
// it is still running.
//
// This page used to say renaming happened "on the organisation chart, which
// owns those writes". It did not: renameNode() had no caller anywhere in the
// app, so a unit's name was whatever it was typed as at creation, forever. A
// page called Unit settings is where those settings belong.
export function UnitSettingsPage(): JSX.Element {
  const { t } = useI18n();
  const { nodeId } = useParams<{ nodeId: string }>();

  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const reach = useQuery({ queryKey: ["org", "reach"], queryFn: getMyCapabilityReach });
  const isAdmin = reach.data?.isAdmin === true;

  const tree = useQuery({
    queryKey: ["org", "tree"],
    queryFn: getOrgTree,
    enabled: isAdmin,
  });

  const natures = useQuery({
    queryKey: ["org", "natures"],
    queryFn: listNodeNatures,
    enabled: isAdmin,
  });

  const current = findNode(tree.data ?? [], nodeId);

  useEffect(() => {
    if (!current) return;
    setName(current.name);
    setNameEn(current.name_en ?? "");
  }, [current]);

  const afterWrite = () => {
    setError(null);
    queryClient.invalidateQueries({ queryKey: ["org", "tree"] });
  };

  const rename = useMutation({
    mutationFn: () => renameNode(nodeId as string, name, nameEn.trim() || null),
    onSuccess: () => {
      afterWrite();
      setSaved(true);
    },
    onError: (e) => setError(errorMessage(e, t("orgtree.write_failed"))),
  });

  // The nature picker used to be rendered only while a node had no effective
  // nature, so once one was set -- or inherited from an ancestor -- it could
  // never be changed or cleared. It is always editable here.
  const changeNature = useMutation({
    mutationFn: (key: string) => setNodeNature(nodeId as string, key || null),
    onSuccess: afterWrite,
    onError: (e) => setError(errorMessage(e, t("orgtree.write_failed"))),
  });

  // Hiding takes the subtree with it: a department hidden while its teams stay
  // on the chart would leave them parented to something nobody can see.
  const hide = useMutation({
    mutationFn: () => archiveEntity("org_node", nodeId as string),
    onSuccess: () => {
      window.location.replace("/org");
    },
  });

  const toggleActive = useMutation({
    mutationFn: (active: boolean) => setNodeActive(nodeId as string, active),
    onSuccess: afterWrite,
    onError: (e) => setError(errorMessage(e, t("orgtree.write_failed"))),
  });

  if (reach.isLoading || (isAdmin && tree.isLoading)) {
    return <ListSkeleton rows={3} label={t("common.loading")} />;
  }
  if (!isAdmin) {
    return <ErrorState message={t("common.access_denied")} />;
  }
  if (tree.isError) {
    return <ErrorState message={errorMessage(tree.error, t("orgtree.load_failed"))} />;
  }

  const node = findNode(tree.data ?? [], nodeId);
  if (!node) {
    return <ErrorState message={t("orgtree.node_not_found")} />;
  }

  return (
    <div className="space-y-6">
      <div>
        <Link
          to={`/org/node/${nodeId}`}
          className="inline-flex min-h-11 items-center text-sm text-primary-text hover:underline"
        >
          {t("unit.back_to_node")}
        </Link>
        <h1 className="mt-2 font-display text-2xl font-bold text-ink">{t("unitsettings.title")}</h1>
      </div>

      {error && <Alert variant="error">{error}</Alert>}
      {saved && !rename.isPending && <Alert variant="success">{t("unitsettings.saved")}</Alert>}

      <Section
        title={t("unitsettings.identity_title")}
        description={t("unitsettings.identity_hint")}
      >
        <div className="space-y-4 py-2">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="unit-name">{t("unitsettings.name_label")}</Label>
              <Input
                id="unit-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setSaved(false);
                }}
                disabled={rename.isPending}
              />
            </div>
            <div>
              <Label htmlFor="unit-name-en">{t("unitsettings.name_en_label")}</Label>
              <Input
                id="unit-name-en"
                value={nameEn}
                onChange={(e) => {
                  setNameEn(e.target.value);
                  setSaved(false);
                }}
                disabled={rename.isPending}
              />
            </div>
          </div>
          <div className="flex justify-end">
            <Button
              onClick={() => rename.mutate()}
              disabled={
                rename.isPending ||
                !name.trim() ||
                (name === node.name && (nameEn.trim() || null) === (node.name_en ?? null))
              }
            >
              {rename.isPending ? t("common.loading") : t("common.save")}
            </Button>
          </div>

          <div className="border-t border-border pt-4">
            <Label htmlFor="unit-nature">{t("orgtree.nature")}</Label>
            <Select
              id="unit-nature"
              value={node.nature_set_here ?? ""}
              onChange={(key) => changeNature.mutate(key)}
              ariaLabel={t("orgtree.nature")}
              disabled={changeNature.isPending}
              options={[
                { value: "", label: t("orgtree.nature_inherit") },
                ...(natures.data ?? []).map((n) => ({ value: n.key, label: n.name_vi })),
              ]}
            />
            <p className="mt-1 text-xs text-muted-foreground">{t("unitsettings.nature_hint")}</p>
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
            <span className="text-sm text-muted-foreground">{t("common.status")}</span>
            {node.active ? (
              <Pill tone="success">{t("unitsettings.active")}</Pill>
            ) : (
              <Pill tone="danger">{t("orgtree.inactive")}</Pill>
            )}
            <Button
              size="sm"
              variant={node.active ? "danger" : "secondary"}
              disabled={toggleActive.isPending}
              onClick={() => toggleActive.mutate(!node.active)}
            >
              {node.active ? t("unitsettings.deactivate") : t("unitsettings.reactivate")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t("unitsettings.deactivate_hint")}</p>

          {/* Deactivating and hiding are different asks. The first is a fact
              about the business and stays on the chart; the second is a fact
              about the person looking. Offered once the unit is inactive, so
              the subtree is already out of authority before it leaves view. */}
          {!node.active && (
            <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
              <Button
                size="sm"
                variant="ghost"
                disabled={hide.isPending}
                onClick={() => {
                  if (window.confirm(t("unitsettings.delete_confirm", { name: node.name }))) {
                    hide.mutate();
                  }
                }}
              >
                {t("unitsettings.delete")}
              </Button>
              {hide.isError && (
                <span className="text-xs text-danger">
                  {errorMessage(hide.error, t("archive.failed"))}
                </span>
              )}
            </div>
          )}
        </div>
      </Section>

      <Card>
        <CardTitle>{t("unitsettings.capabilities_title")}</CardTitle>
        {node.capabilities.length === 0 ? (
          <p className="text-sm text-ink-muted">{t("unitsettings.capabilities_none")}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {node.capabilities.map((key) => (
              <Pill key={key} tone="accent">
                {humanize(key)}
              </Pill>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <CardTitle>{t("unitsettings.cameras_title")}</CardTitle>
        <p className="text-sm text-ink-muted">{t("unitsettings.cameras_hint")}</p>
        <div className="mt-4">
          <Link
            to={`/org/node/${nodeId}/cameras`}
            className="text-sm font-medium text-primary-text hover:underline"
          >
            {t("unit.view_cameras")}
          </Link>
        </div>
      </Card>
    </div>
  );
}
