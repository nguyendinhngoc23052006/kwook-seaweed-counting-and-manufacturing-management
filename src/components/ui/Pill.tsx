import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

// The petal hues are brand, not text: gold and green fail AA on white. Each
// tone therefore pairs the -subtle tint as a background with the -text ink.
const pillVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium [&>svg]:size-3",
  {
    variants: {
      tone: {
        neutral: "bg-muted text-muted-foreground",
        accent: "bg-primary-subtle text-primary-text",
        success: "bg-success-subtle text-success-text",
        warning: "bg-warning-subtle text-warning-text",
        danger: "bg-danger-subtle text-danger-text",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export interface PillProps extends ComponentProps<"span">, VariantProps<typeof pillVariants> {
  asChild?: boolean;
}

export function Pill({ className, tone, asChild = false, ...props }: PillProps) {
  const Comp = asChild ? Slot : "span";
  return <Comp className={cn(pillVariants({ tone }), className)} {...props} />;
}
