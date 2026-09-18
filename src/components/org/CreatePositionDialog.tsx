import { useMutation } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { errorMessage } from "../../lib/errorMessage";
import { useI18n } from "../../lib/i18n";
import { nodeLabel, rankLabel } from "../../lib/orgLabels";
import type { OrgTreeNode, OrgTreeSeat } from "../../services/nodes";
import { hasRootSeat, managerSeatChoices } from "../../services/nodes";
import type { Rank } from "../../services/positions";
import { createPosition } from "../../services/positions";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Input, Label } from "../ui/Input";
import { TouchSelect } from "./TouchSelect";

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  onAssign: (seat: OrgTreeSeat) => void;
  node: OrgTreeNode;
  nodes: OrgTreeNode[];
  ranks: Rank[];
  isAdmin: boolean;
}

// THE OFFICE DOORWAY. The seat is created first — "Head of Marketing" exists,
// and stands empty until an account or a person is assigned to it. Underneath
// it is the same two records as the field doorway; only this door differs.
export function CreatePositionDialog(props: Props): JSX.Element | null {
  const { open, onClose, onCreated, onAssign, node, nodes, ranks, isAdmin } = props;
  const { t, locale } = useI18n();

  const [title, setTitle] = useState("");
  const [titleEn, setTitleEn] = useState("");
  const [rankKey, setRankKey] = useState("");
  const [managerPositionId, setManagerPositionId] = useState("");
  const [createdPositionId, setCreatedPositionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choices: { seat: OrgTreeSeat; node: OrgTreeNode }[] = managerSeatChoices(nodes, node.id);
  const rootSeatFree = !hasRootSeat(nodes) && isAdmin;
  const manager = choices.find((choice) => choice.seat.position_id === managerPositionId);
  const availableRanks = manager
    ? ranks.filter((rank) => rank.ordinal >= manager.seat.rank_ordinal)
    : ranks;
  const rankValue = availableRanks.some((rank) => rank.key === rankKey) ? rankKey : "";
  const selectedRank = availableRanks.find((rank) => rank.key === rankValue);

  const reset = () => {
    setTitle("");
    setTitleEn("");
    setRankKey("");
    setManagerPositionId("");
    setCreatedPositionId(null);
    setError(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  const finish = () => {
    reset();
    onCreated();
    onClose();
  };

  const create = useMutation({
    mutationFn: () =>
      createPosition({
        nodeId: node.id,
        rankId: selectedRank?.id ?? "",
        title,
        titleEn,
        reportsToPositionId: managerPositionId || null,
      }),
    onSuccess: (position) => {
      setError(null);
      setCreatedPositionId(position.id);
    },
    onError: (e) => setError(errorMessage(e, t("orgtree.write_failed"))),
  });

  const canSubmit =
    title.trim() !== "" &&
    rankValue !== "" &&
    (managerPositionId !== "" || rootSeatFree) &&
    !create.isPending;

  if (!open) return null;

  if (createdPositionId) {
    const positionId = createdPositionId;
    return (
      <Dialog
        open={open}
        onClose={finish}
        title={t("position.created_title")}
        footer={
          <>
            <Button variant="ghost" onClick={finish}>
              {t("position.leave_empty")}
            </Button>
            <Button
              onClick={() => {
                // The seat is handed over whole rather than by id: the tree
                // query has not refetched yet, so looking it up there would
                // open nothing and read as a dead button.
                const seat: OrgTreeSeat = {
                  position_id: positionId,
                  title: title.trim(),
                  rank_key: selectedRank?.key ?? "",
                  rank_ordinal: selectedRank?.ordinal ?? 0,
                  reports_to: managerPositionId || null,
                  person_id: null,
                  person_name: null,
                  employee_code: null,
                };
                reset();
                onCreated();
                onAssign(seat);
              }}
            >
              {t("position.assign_now")}
            </Button>
          </>
        }
      >
        <Alert variant="success">{t("position.created_body", { title: title.trim() })}</Alert>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={t("position.title", { node: nodeLabel(node, locale) })}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={create.isPending}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => create.mutate()} disabled={!canSubmit}>
            {create.isPending ? t("common.loading") : t("position.submit")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-ink-muted">{t("position.hint")}</p>
        {error && <Alert variant="error">{error}</Alert>}

        <div>
          <Label htmlFor="position-title">{t("position.seat_title")}</Label>
          <Input
            id="position-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("position.seat_title_placeholder")}
            disabled={create.isPending}
          />
        </div>

        <div>
          <Label htmlFor="position-title-en">{t("position.seat_title_en")}</Label>
          <Input
            id="position-title-en"
            value={titleEn}
            onChange={(e) => setTitleEn(e.target.value)}
            disabled={create.isPending}
          />
        </div>

        <div>
          <Label htmlFor="position-manager">{t("seat.reports_to")}</Label>
          <TouchSelect
            id="position-manager"
            value={managerPositionId}
            onChange={(value) => setManagerPositionId(value)}
            disabled={create.isPending}
            searchable={choices.length >= 6}
            ariaLabel={t("seat.reports_to")}
            options={[
              {
                value: "",
                label: rootSeatFree ? t("seat.no_manager_root") : t("seat.pick_manager"),
              },
              ...choices.map(({ seat, node: seatNode }) => ({
                value: seat.position_id,
                label: `${seat.title} · ${nodeLabel(seatNode, locale)}${
                  seat.person_name ? ` — ${seat.person_name}` : ""
                }`,
              })),
            ]}
          />
          {choices.length === 0 && !rootSeatFree && (
            <p className="mt-1 text-xs text-danger-text">{t("seat.no_manager_available")}</p>
          )}
        </div>

        <div>
          <Label htmlFor="position-rank">{t("seat.rank")}</Label>
          <TouchSelect
            id="position-rank"
            value={rankValue}
            onChange={(value) => setRankKey(value)}
            disabled={create.isPending}
            ariaLabel={t("seat.rank")}
            options={[
              { value: "", label: t("seat.pick_rank") },
              ...availableRanks.map((rank) => ({
                value: rank.key,
                label: rankLabel(rank, locale),
              })),
            ]}
          />
          {manager && availableRanks.length < ranks.length && (
            <p className="mt-1 text-xs text-ink-muted">
              {t("seat.rank_filtered", { title: manager.seat.title })}
            </p>
          )}
        </div>
      </div>
    </Dialog>
  );
}
