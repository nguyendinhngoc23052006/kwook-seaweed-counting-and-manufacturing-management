import type { ReactNode } from "react";
import { ListSkeleton } from "./Skeleton";

// An empty state owes the reader a cause and at most one way out. It must not
// render an action the viewer is not allowed to take -- a disabled button
// reads as a broken app, where a sentence reads as an explanation.
export function Empty({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed border-hairline-strong px-6 py-10 text-center">
      <p className="font-medium text-ink">{title}</p>
      {description && (
        <p className="mx-auto mt-1 max-w-prose text-sm text-ink-muted">{description}</p>
      )}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

// Back-compatible wrappers: 20+ call sites pass children, and changing them
// all belongs in the PR that rebuilds those screens, not this one.
export function EmptyState({ children }: { children: ReactNode }) {
  return <Empty title={children} />;
}

export function LoadingState({ children }: { children?: ReactNode }) {
  return <ListSkeleton label={typeof children === "string" ? children : undefined} />;
}

export function ErrorState({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-danger-subtle bg-danger-subtle p-4 text-sm text-danger-text"
    >
      <p>{message}</p>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
