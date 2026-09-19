import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

// Tinted background plus AA-safe ink, from the token triplets -- not the raw
// Tailwind palette, which does not follow the theme and has no dark mode here.
//
// A flex row, NOT a grid. The grid this replaces was `grid-cols-[0_1fr]` with
// its children placed at `col-start-2`, which only works if every child is one
// of those children. 65 of this component's 68 callers pass a bare string, and
// a bare string is an ANONYMOUS item: it landed in column one, which is 0px
// wide, so every error and warning banner in the hub wrapped one word per line.
// In a flex row an anonymous item is a real flex item that fills the row and
// wraps like prose, and an icon child still sits beside it.
const alertVariants = cva(
  "flex w-full items-start gap-3 rounded-lg border p-3 text-sm [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:translate-y-0.5",
  {
    variants: {
      variant: {
        success: "border-success-subtle bg-success-subtle text-success-text",
        error: "border-danger-subtle bg-danger-subtle text-danger-text",
        info: "border-primary-subtle bg-primary-subtle text-primary-text",
        warning: "border-warning-subtle bg-warning-subtle text-warning-text",
      },
    },
    defaultVariants: { variant: "info" },
  },
);

export interface AlertProps extends ComponentProps<"div">, VariantProps<typeof alertVariants> {}

export function Alert({ className, variant, ...props }: AlertProps) {
  return (
    <div
      role="alert"
      aria-live="polite"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

// For an alert whose body is more than one sentence -- it takes the row's free
// space so its own children stack, and `min-w-0` lets it shrink rather than
// forcing the banner wider than its container.
export function AlertDescription({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("min-w-0 flex-1", className)} {...props} />;
}
