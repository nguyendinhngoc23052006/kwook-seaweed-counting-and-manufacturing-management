import * as AvatarPrimitive from "@radix-ui/react-avatar";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

export function Avatar({ className, ...props }: ComponentProps<typeof AvatarPrimitive.Root>) {
  return (
    <AvatarPrimitive.Root
      className={cn("relative flex size-10 shrink-0 overflow-hidden rounded-full", className)}
      {...props}
    />
  );
}

export function AvatarImage({ className, ...props }: ComponentProps<typeof AvatarPrimitive.Image>) {
  return (
    <AvatarPrimitive.Image
      className={cn("aspect-square size-full object-cover", className)}
      {...props}
    />
  );
}

export function AvatarFallback({
  className,
  ...props
}: ComponentProps<typeof AvatarPrimitive.Fallback>) {
  return (
    <AvatarPrimitive.Fallback
      className={cn(
        "flex size-full items-center justify-center rounded-full bg-primary-subtle text-sm font-medium text-primary-text",
        className,
      )}
      {...props}
    />
  );
}

// Vietnamese names run given-name-last, so the meaningful initial is the LAST
// word, not the first: "Nguyễn Đình Ngọc" is N-go-c, not N-guyen.
export function initialsOf(fullName: string): string {
  const words = fullName.trim().split(/\s+/).filter(Boolean);
  const last = words.at(-1);
  if (!last) return "?";
  const first = words.length > 1 ? words.at(-2) : undefined;
  return ((first?.[0] ?? "") + last[0]).toUpperCase();
}
