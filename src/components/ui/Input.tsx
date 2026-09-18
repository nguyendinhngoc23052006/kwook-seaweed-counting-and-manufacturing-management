import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";

// text-base, never text-sm: iOS Safari auto-zooms any focused input whose
// font-size is under 16px, which shifts the whole layout sideways and does not
// zoom back out. It reads as the page breaking when you tap a field.
//
// No focus:outline-none here. index.css sets one focus ring for everything via
// :where(...), which has ZERO specificity -- so a utility like outline-none
// (0,2,0) silently beats it and the field is left with a 1px border-colour
// change as its only focus indicator. In poor light, on a phone, in gloves,
// that is no indicator at all.
const field =
  "block w-full rounded-lg border border-hairline bg-surface-raised px-3 py-2.5 text-base text-ink shadow-sm placeholder:text-ink-faint focus:border-accent disabled:opacity-60";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${field} min-h-12 ${className ?? ""}`} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`${field} ${className ?? ""}`} {...props} />;
}

export function Label({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 block text-sm font-medium text-ink">
      {children}
    </label>
  );
}
