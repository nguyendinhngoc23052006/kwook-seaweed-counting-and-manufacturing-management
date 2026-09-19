import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "./Card";

// A titled region with room for one action. Built on Card so a Section and a
// Card cannot drift apart -- there is one surface treatment in the app.
export function Section({
  title,
  description,
  action,
  children,
  className,
  contentClassName,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <Card className={cn("gap-0 py-0", className)}>
      <CardHeader className="border-b border-border py-3.5">
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent className={cn("py-2", contentClassName)}>{children}</CardContent>
    </Card>
  );
}
