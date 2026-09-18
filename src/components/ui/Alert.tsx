import type { JSX, ReactNode } from "react";

type AlertVariant = "success" | "error" | "info" | "warning";

export interface AlertProps {
  variant: AlertVariant;
  children: ReactNode;
  className?: string;
}

// Tinted background plus AA-safe ink, from the token triplets -- not the raw
// Tailwind palette, which does not follow the theme and has no dark mode here.
const variantStyles: Record<AlertVariant, string> = {
  success: "bg-success-subtle border-success-subtle text-success-text",
  error: "bg-danger-subtle border-danger-subtle text-danger-text",
  info: "bg-accent-subtle border-accent-subtle text-accent-text",
  warning: "bg-warning-subtle border-warning-subtle text-warning-text",
};

export function Alert(props: AlertProps): JSX.Element {
  const { variant, children, className = "" } = props;

  return (
    <div
      role="alert"
      aria-live="polite"
      className={`rounded-lg border p-3 text-sm ${variantStyles[variant]} ${className}`}
    >
      {children}
    </div>
  );
}
