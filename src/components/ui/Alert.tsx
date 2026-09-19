import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

// Tinted background plus AA-safe ink, from the token triplets -- not the raw
// Tailwind palette, which does not follow the theme and has no dark mode here.
const alertVariants = cva(
  "grid w-full grid-cols-[0_1fr] items-start gap-y-1 rounded-lg border p-3 text-sm has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] has-[>svg]:gap-x-3 [&>svg]:size-4 [&>svg]:translate-y-0.5",
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

export function AlertTitle({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("col-start-2 font-medium", className)} {...props} />;
}

export function AlertDescription({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("col-start-2 text-sm", className)} {...props} />;
}
