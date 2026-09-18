import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { vi } from "date-fns/locale";
import { type JSX, useState } from "react";
import { errorMessage } from "../../lib/errorMessage";
import { useI18n } from "../../lib/i18n";
import { addTaskComment, listTaskComments, type TaskComment } from "../../services/taskComments";
import { Button } from "../ui/Button";
import { EmptyState, ErrorState } from "../ui/EmptyState";
import { Textarea } from "../ui/Input";
import { Section } from "../ui/Section";
import { ListSkeleton } from "../ui/Skeleton";

function CommentRow({ comment, locale }: { comment: TaskComment; locale: string }) {
  const when = formatDistanceToNow(new Date(comment.created_at), {
    addSuffix: true,
    locale: locale === "vi" ? vi : undefined,
  });
  return (
    <li className="border-t border-hairline py-3 first:border-0 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-ink">{comment.author_title}</span>
        <span className="text-xs text-ink-faint">{when}</span>
      </div>
      <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-ink-muted">
        {comment.body}
      </p>
    </li>
  );
}

// Oldest-first thread on a single task, with its own add form. Standalone --
// TaskCard.tsx decides where (or whether) to mount it.
export function TaskCommentsThread({ taskId }: { taskId: string }): JSX.Element {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const [body, setBody] = useState("");
  const queryKey = ["work", "comments", taskId];

  const comments = useQuery({
    queryKey,
    queryFn: () => listTaskComments(taskId),
  });

  const post = useMutation({
    mutationFn: (text: string) => addTaskComment(taskId, text),
    onSuccess: () => {
      setBody("");
      qc.invalidateQueries({ queryKey });
    },
  });

  const trimmed = body.trim();

  return (
    <Section title={t("comments.title")}>
      {comments.isLoading ? (
        <ListSkeleton rows={2} label={t("comments.title")} />
      ) : comments.isError ? (
        <ErrorState message={errorMessage(comments.error, t("comments.load_failed"))} />
      ) : comments.data && comments.data.length > 0 ? (
        <ul>
          {comments.data.map((c) => (
            <CommentRow key={c.id} comment={c} locale={locale} />
          ))}
        </ul>
      ) : (
        <EmptyState>{t("comments.empty")}</EmptyState>
      )}

      <form
        className="mt-3 space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!trimmed || post.isPending) return;
          post.mutate(trimmed);
        }}
      >
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={t("comments.placeholder")}
          rows={3}
          disabled={post.isPending}
        />
        {post.isError && (
          <ErrorState message={errorMessage(post.error, t("comments.post_failed"))} />
        )}
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={!trimmed || post.isPending}>
            {post.isPending ? t("comments.submitting") : t("comments.submit")}
          </Button>
        </div>
      </form>
    </Section>
  );
}
