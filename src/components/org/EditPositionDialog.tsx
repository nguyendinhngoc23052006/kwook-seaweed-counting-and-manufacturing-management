import { useMutation } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { errorMessage } from "../../lib/errorMessage";
import { useI18n } from "../../lib/i18n";
import { nodeLabel, rankLabel } from "../../lib/orgLabels";
import { managerSeatChoices, type OrgTreeNode, type OrgTreeSeat } from "../../services/nodes";
import { abolishPosition, movePosition, updatePosition } from "../../services/positions";
import type { Rank } from "../../services/ranks";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Input, Label } from "../ui/Input";
import { Select } from "../ui/Select";

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  seat: OrgTreeSeat;
  // The whole tree, so the seat can be re-hung under a manager somewhere else.
  nodes: OrgTreeNode[];
  nodeId: string;
  ranks: Rank[];
  // The most senior rank the viewer holds, or null for an org admin, who is
  // bound by none of this. Everyone else may only touch a seat strictly below
  // their own rank -- org_guard_positions refuses the rest, and this filter
  // exists so the refusal is rare rather than the normal way to find out.
  myRankOrdinal: number | null;
}

// The other half of a seat's life. Creating it, filling it, emptying it and
// moving it were all reachable; changing what it IS was not, in any screen,
// since the model shipped.
export function EditPositionDialog({
  open,
  onClose,
  onSaved,
  seat,
  nodes,
  nodeId,
  ranks,
  myRankOrdinal,
}: Props): JSX.Element | null {
  const { t, locale } = useI18n();
  const [title, setTitle] = useState(seat.title);
  const [rankKey, setRankKey] = useState(seat.rank_key);
  const [confirmingAbolish, setConfirmingAbolish] = useState(false);
  const [managerPositionId, setManagerPositionId] = useState(seat.reports_to ?? "");
  const [error, setError] = useState<string | null>(null);

  const allowedRanks =
    myRankOrdinal === null ? ranks : ranks.filter((rank) => rank.ordinal > myRankOrdinal);
  const selectedRank = allowedRanks.find((rank) => rank.key === rankKey);

  const save = useMutation({
    mutationFn: () =>
      updatePosition({
        positionId: seat.position_id,
        title,
        rankId: selectedRank?.id ?? "",
      }),
    onSuccess: () => {
      setError(null);
      onSaved();
      onClose();
    },
    onError: (e) => setError(errorMessage(e, t("orgtree.write_failed"))),
  });

  // movePosition() has existed since the model shipped and no rendered control
  // ever called it, so a seat could be created in the wrong unit and never
  // moved. The database wants appoint reach at BOTH ends and refuses a manager
  // outside your own branch; this only offers what it would accept.
  const move = useMutation({
    mutationFn: () => {
      const target = choices.find((c) => c.seat.position_id === managerPositionId);
      return movePosition({
        positionId: seat.position_id,
        newNodeId: target?.node.id ?? nodeId,
        newReportsToPositionId: managerPositionId || null,
      });
    },
    onSuccess: () => {
      setError(null);
      onSaved();
      onClose();
    },
    onError: (e) => setError(errorMessage(e, t("orgtree.write_failed"))),
  });

  const abolish = useMutation({
    mutationFn: () => abolishPosition(seat.position_id),
    onSuccess: () => {
      setError(null);
      onSaved();
      onClose();
    },
    onError: (e) => setError(errorMessage(e, t("orgtree.write_failed"))),
  });

  // A seat cannot be its own manager, and the root seat has none to pick.
  const choices = managerSeatChoices(nodes, nodeId).filter(
    (c) => c.seat.position_id !== seat.position_id,
  );
  const busy = save.isPending || abolish.isPending || move.isPending;
  const changed = title.trim() !== seat.title || rankKey !== seat.rank_key;
  const canSave = title.trim() !== "" && selectedRank !== undefined && changed && !busy;

  if (!open) return null;

  if (confirmingAbolish) {
    return (
      <Dialog
        open={open}
        onClose={() => setConfirmingAbolish(false)}
        title={t("seat_edit.abolish_title")}
        description={t("seat_edit.abolish_body", { title: seat.title })}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmingAbolish(false)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button variant="danger" onClick={() => abolish.mutate()} disabled={busy}>
              {abolish.isPending ? t("common.loading") : t("seat_edit.abolish_confirm")}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {seat.person_name && (
            <Alert variant="warning">
              {t("seat_edit.abolish_occupied", { name: seat.person_name })}
            </Alert>
          )}
          {error && <Alert variant="error">{error}</Alert>}
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("seat_edit.title", { title: seat.title })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => save.mutate()} disabled={!canSave}>
            {save.isPending ? t("common.loading") : t("seat_edit.submit")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert variant="error">{error}</Alert>}

        <div>
          <Label htmlFor="seat-edit-title">{t("position.seat_title")}</Label>
          <Input
            id="seat-edit-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={busy}
          />
        </div>

        <div>
          <Label htmlFor="seat-edit-rank">{t("seat.rank")}</Label>
          <Select
            id="seat-edit-rank"
            value={rankKey}
            onChange={setRankKey}
            disabled={busy}
            ariaLabel={t("seat.rank")}
            options={allowedRanks.map((rank) => ({
              value: rank.key,
              label: rankLabel(rank, locale),
            }))}
          />
          {myRankOrdinal !== null && allowedRanks.length < ranks.length && (
            <p className="mt-1 text-xs text-muted-foreground">{t("seat_edit.rank_filtered")}</p>
          )}
          {/* A seat whose current rank is at or above the viewer's is not in
              the list at all, so say why rather than showing an empty field. */}
          {selectedRank === undefined && (
            <p className="mt-1 text-xs text-danger-text">{t("seat_edit.rank_above_you")}</p>
          )}
        </div>

        {choices.length > 0 && (
          <div className="border-t border-border pt-4">
            <Label htmlFor="seat-edit-manager">{t("seat.reports_to")}</Label>
            <Select
              id="seat-edit-manager"
              value={managerPositionId}
              onChange={setManagerPositionId}
              ariaLabel={t("seat.reports_to")}
              disabled={busy}
              searchable={choices.length >= 6}
              options={choices.map(({ seat: s2, node }) => ({
                value: s2.position_id,
                label: `${s2.title} · ${nodeLabel(node, locale)}`,
              }))}
            />
            <div className="mt-2 flex justify-end">
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || !managerPositionId || managerPositionId === seat.reports_to}
                onClick={() => move.mutate()}
              >
                {move.isPending ? t("common.loading") : t("seat_edit.move")}
              </Button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{t("seat_edit.move_hint")}</p>
          </div>
        )}

        <div className="border-t border-border pt-4">
          <Button
            variant="danger"
            onClick={() => setConfirmingAbolish(true)}
            disabled={busy || selectedRank === undefined}
          >
            {t("seat_edit.abolish")}
          </Button>
          <p className="mt-1 text-xs text-muted-foreground">{t("seat_edit.abolish_hint")}</p>
        </div>
      </div>
    </Dialog>
  );
}
