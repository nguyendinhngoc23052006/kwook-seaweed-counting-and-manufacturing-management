import type { ReactNode } from "react";

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-xl border border-hairline bg-surface-raised p-4 shadow-sm sm:p-5 ${className ?? ""}`}
    >
      {children}
    </div>
  );
}

export function CardTitle({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <h2 className={`mb-3 font-display text-lg font-semibold text-ink ${className ?? ""}`}>
      {children}
    </h2>
  );
}
