import * as LabelPrimitive from "@radix-ui/react-label";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

// text-base, never text-sm: iOS Safari auto-zooms any focused input whose
// font-size is under 16px, which shifts the whole layout sideways and does not
// zoom back out. It reads as the page breaking when you tap a field.
const field =
  "block w-full rounded-lg border border-input bg-card px-3 py-2.5 text-base text-foreground shadow-sm outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-destructive aria-invalid:ring-destructive/25";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input data-slot="input" className={cn(field, "min-h-12", className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea data-slot="textarea" className={cn(field, "min-h-20", className)} {...props} />;
}

export function Label({ className, ...props }: ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        "mb-1 flex items-center gap-2 text-sm font-medium leading-snug text-foreground select-none",
        className,
      )}
      {...props}
    />
  );
}
