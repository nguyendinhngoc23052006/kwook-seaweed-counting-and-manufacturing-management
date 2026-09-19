import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import { useId } from "react";
import { cn } from "../../lib/utils";

export interface CheckboxProps {
  id?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  className?: string;
}

// The whole label is the target and it is 44px tall, because the box itself is
// 20px and nobody hits a 20px box on a phone wearing gloves. Radix renders a
// <button>, not an <input>, so the association has to be an explicit htmlFor --
// wrapping it in a <label> alone associates nothing.
export function Checkbox({ id, checked, onChange, disabled, label, className }: CheckboxProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;

  return (
    <div
      className={cn(
        "inline-flex min-h-11 items-center gap-2.5",
        disabled && "opacity-50",
        className,
      )}
    >
      <CheckboxPrimitive.Root
        id={controlId}
        checked={checked}
        onCheckedChange={(next) => onChange(next === true)}
        disabled={disabled}
        className="peer size-5 shrink-0 rounded-[4px] border border-input bg-card shadow-sm outline-none transition-shadow focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground"
      >
        <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
          <Check className="size-3.5" strokeWidth={3} />
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      {label && (
        <label
          htmlFor={controlId}
          className={cn(
            "cursor-pointer select-none text-sm text-foreground",
            disabled && "cursor-not-allowed",
          )}
        >
          {label}
        </label>
      )}
    </div>
  );
}
