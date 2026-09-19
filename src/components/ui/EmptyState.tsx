import type { ReactNode } from "react";
import { Alert, AlertDescription } from "./Alert";
import { ListSkeleton } from "./Skeleton";

// An empty state owes the reader a cause and at most one way out. It must not
// render an action the viewer is not allowed to take -- a disabled button
// reads as a broken app, where a sentence reads as an explanation.
export function Empty({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-border px-6 py-10 text-center">
      {icon && (
        <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
          {icon}
        </div>
      )}
      <p className="font-medium text-foreground">{title}</p>
      {description && (
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <Empty title={children} />;
}

export function LoadingState({ children }: { children?: ReactNode }) {
  return <ListSkeleton label={typeof children === "string" ? children : undefined} />;
}

export function ErrorState({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <Alert variant="error">
      <AlertDescription>
        <p>{message}</p>
        {action && <div className="mt-3">{action}</div>}
      </AlertDescription>
    </Alert>
  );
}
