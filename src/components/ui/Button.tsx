import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "danger" | "ghost";
type Size = "md" | "sm";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const styles: Record<Variant, string> = {
  primary:
    "bg-accent text-accent-on hover:bg-accent-strong disabled:bg-ink-faint disabled:text-surface",
  secondary:
    "bg-surface-raised text-ink border border-hairline hover:bg-surface-muted disabled:opacity-50",
  danger: "bg-danger-fill text-white hover:brightness-95 disabled:opacity-50",
  ghost: "text-ink hover:bg-surface-muted disabled:opacity-50",
};

// 48px default, 44px minimum. Every button in the app was 34px tall, which is
// below the touch floor on every platform guideline -- and this is used in a
// warehouse, on phones, by people wearing gloves.
const sizes: Record<Size, string> = {
  md: "min-h-12 px-4 text-base",
  sm: "min-h-11 px-3 text-sm",
};

export function Button({ variant = "primary", size = "md", className, ...props }: Props) {
  return (
    <button
      type={props.type ?? "button"}
      className={`inline-flex items-center justify-center gap-2 rounded-lg font-medium transition disabled:cursor-not-allowed ${sizes[size]} ${styles[variant]} ${className ?? ""}`}
      {...props}
    />
  );
}
