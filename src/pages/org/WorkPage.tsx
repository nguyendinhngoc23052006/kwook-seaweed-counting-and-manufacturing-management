import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type JSX, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AssignTaskDialog } from "../../components/org/AssignTaskDialog";
import { TaskCardView } from "../../components/org/TaskCard";
import { TouchSelect } from "../../components/org/TouchSelect";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Empty, ErrorState } from "../../components/ui/EmptyState";
import { Label, Textarea } from "../../components/ui/Input";
import { Section } from "../../components/ui/Section";
import { ListSkeleton } from "../../components/ui/Skeleton";
import { errorMessage } from "../../lib/errorMessage";
import { useI18n } from "../../lib/i18n";
import {
  acceptTask,
  cancelTask,
  getTaskBoard,
  handTaskAcross,
  listPeerSeats,
  rejectTask,
  submitTask,
  type TaskCard,
} from "../../services/tasks";

type Prompt = { kind: "reject"; task: TaskCard } | { kind: "hand"; task: TaskCard } | null;

// The work board. Three questions a person actually has: what do I owe, what is
// waiting on me, and what did I hand out. The node bucket is the fourth, and it
// only appears when you arrive from a node you may see the workload of.
export function WorkPage(): JSX.Element {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const nodeId = params.get("node") ?? undefined;

  const [assigning, setAssigning] = useState(false);
  const [prompt, setPrompt] = useState<Prompt>(null);
  const [note, setNote] = useState("");
  const [peerId, setPeerId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const board = useQuery({
    queryKey: ["work", "board", nodeId ?? null],
    queryFn: () => getTaskBoard(nodeId),
  });

  const peers = useQuery({
    queryKey: ["work", "peers", prompt?.kind === "hand" ? prompt.task.id : null],
    queryFn: () => listPeerSeats(prompt?.kind === "hand" ? prompt.task.id : ""),
    enabled: prompt?.kind === "hand",
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["work"] });
    setPrompt(null);
    setNote("");
    setPeerId("");
    setError(null);
  };

  const act = useMutation({
    mutationFn: (job: () => Promise<void>) => job(),
    onSuccess: refresh,
    onError: (e) => setError(errorMessage(e, t("work.action_failed"))),
  });

  if (board.isLoading) return <ListSkeleton rows={4} label={t("work.loading")} />;
  if (board.isError) {
    return (
      <ErrorState
        message={errorMessage(board.error, t("work.load_failed"))}
        action={<Button onClick={() => board.refetch()}>{t("common.retry")}</Button>}
      />
    );
  }

  const b = board.data ?? {
    my_seats: [],
    mine: [],
    awaiting: [],
    given: [],
    node: [],
  };
  const nothing =
    b.mine.length === 0 && b.awaiting.length === 0 && b.given.length === 0 && b.node.length === 0;

  // The reject and hand-across dialogs share one note field. It is cleared on
  // the way in and on the way out, because a note becomes a permanent row in an
  // append-only log: a bounce reason typed and cancelled must never turn up as
  // the explanation on a later hand-across.
  const ask = (next: Prompt) => {
    setNote("");
    setPeerId("");
    setError(null);
    setPrompt(next);
  };

  const handlers = {
    onSubmit: (task: TaskCard) => act.mutate(() => submitTask(task.id)),
    onAccept: (task: TaskCard) => act.mutate(() => acceptTask(task.id)),
    onReject: (task: TaskCard) => ask({ kind: "reject", task }),
    onHandAcross: (task: TaskCard) => ask({ kind: "hand", task }),
    onCancel: (task: TaskCard) => act.mutate(() => cancelTask(task.id)),
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink">{t("work.title")}</h1>
          <p className="text-sm leading-relaxed text-ink-muted">{t("work.subtitle")}</p>
        </div>
        {b.my_seats.length > 0 && (
          <Button onClick={() => setAssigning(true)}>{t("work.assign_new")}</Button>
        )}
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      {nothing && (
        <Empty
          title={t("work.empty")}
          description={b.my_seats.length === 0 ? t("work.empty_no_seat") : t("work.empty_hint")}
        />
      )}

      {b.awaiting.length > 0 && (
        <Section title={t("work.awaiting")} description={t("work.awaiting_hint")}>
          <div className="space-y-3 py-3">
            {b.awaiting.map((task) => (
              <TaskCardView
                key={task.id}
                task={task}
                side="given"
                busy={act.isPending}
                {...handlers}
              />
            ))}
          </div>
        </Section>
      )}

      {b.mine.length > 0 && (
        <Section title={t("work.mine")} description={t("work.mine_hint")}>
          <div className="space-y-3 py-3">
            {b.mine.map((task) => (
              <TaskCardView
                key={task.id}
                task={task}
                side="mine"
                busy={act.isPending}
                {...handlers}
              />
            ))}
          </div>
        </Section>
      )}

      {b.given.length > 0 && (
        <Section title={t("work.given")} description={t("work.given_hint")}>
          <div className="space-y-3 py-3">
            {b.given.map((task) => (
              <TaskCardView
                key={task.id}
                task={task}
                side="given"
                busy={act.isPending}
                {...handlers}
              />
            ))}
          </div>
        </Section>
      )}

      {nodeId && b.node.length > 0 && (
        <Section title={t("work.node")} description={t("work.node_hint")}>
          <div className="space-y-3 py-3">
            {b.node.map((task) => (
              <TaskCardView key={task.id} task={task} side="node" busy={act.isPending} />
            ))}
          </div>
        </Section>
      )}

      <AssignTaskDialog
        open={assigning}
        onClose={() => setAssigning(false)}
        onAssigned={refresh}
        mySeats={b.my_seats}
      />

      <Dialog
        open={prompt?.kind === "reject"}
        onClose={() => ask(null)}
        title={t("work.reject_title")}
        footer={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => ask(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              disabled={!note.trim() || act.isPending}
              onClick={() =>
                prompt?.kind === "reject" && act.mutate(() => rejectTask(prompt.task.id, note))
              }
            >
              {t("work.reject")}
            </Button>
          </div>
        }
      >
        <Label htmlFor="work-reject-note">{t("work.reject_why")}</Label>
        <Textarea
          id="work-reject-note"
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t("work.reject_placeholder")}
        />
      </Dialog>

      <Dialog
        open={prompt?.kind === "hand"}
        onClose={() => ask(null)}
        title={t("work.hand_title")}
        footer={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => ask(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              disabled={!peerId || act.isPending}
              onClick={() =>
                prompt?.kind === "hand" &&
                act.mutate(() => handTaskAcross(prompt.task.id, peerId, note))
              }
            >
              {t("work.hand_across")}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-ink-muted">{t("work.hand_explain")}</p>
          <div>
            <Label htmlFor="work-peer">{t("work.which_peer")}</Label>
            {peers.isLoading ? (
              <p className="text-sm text-ink-muted">{t("common.loading")}</p>
            ) : peers.isError ? (
              <p className="text-sm leading-relaxed text-danger-text">{t("work.peers_failed")}</p>
            ) : (peers.data ?? []).length === 0 ? (
              <p className="text-sm leading-relaxed text-ink-muted">{t("work.no_peers")}</p>
            ) : (
              <TouchSelect
                id="work-peer"
                value={peerId}
                onChange={setPeerId}
                ariaLabel={t("work.which_peer")}
                options={[
                  { value: "", label: t("work.pick_seat") },
                  ...(peers.data ?? []).map((p) => ({
                    value: p.position_id,
                    label: p.person_name
                      ? `${p.person_name} — ${p.node_name}`
                      : `${p.title} (${t("work.vacant")}) — ${p.node_name}`,
                  })),
                ]}
              />
            )}
          </div>
          <div>
            <Label htmlFor="work-hand-note">{t("work.note_optional")}</Label>
            <Textarea
              id="work-hand-note"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>
      </Dialog>
    </div>
  );
}
