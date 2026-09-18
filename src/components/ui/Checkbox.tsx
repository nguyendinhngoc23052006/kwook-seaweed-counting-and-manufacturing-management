import type { JSX } from "react";

export interface CheckboxProps {
  id?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  className?: string;
}

export function Checkbox(props: CheckboxProps): JSX.Element {
  const { id, checked, onChange, disabled = false, label, className = "" } = props;

  return (
    <label
      className={`inline-flex min-h-11 items-center gap-2 cursor-pointer ${
        disabled ? "opacity-50 cursor-not-allowed" : ""
      } ${className}`}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.currentTarget.checked)}
        disabled={disabled}
        className="size-5 accent-[var(--kw-accent)]"
      />
      {label && <span className="text-sm text-ink">{label}</span>}
    </label>
  );
}
