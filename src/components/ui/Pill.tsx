import type { ReactNode } from "react";

type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

// The petal hues are brand, not text: gold and green fail AA on white. Each
// tone therefore pairs the -subtle tint as a background with the -text ink.
const tones: Record<Tone, string> = {
  neutral: "bg-surface-muted text-ink-muted",
  accent: "bg-accent-subtle text-accent-text",
  success: "bg-success-subtle text-success-text",
  warning: "bg-warning-subtle text-warning-text",
  danger: "bg-danger-subtle text-danger-text",
};

export function Pill({
  tone = "neutral",
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${tones[tone]} ${className ?? ""}`}
    >
      {children}
    </span>
  );
}
