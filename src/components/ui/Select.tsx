import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "cmdk";
import { Check, ChevronDown } from "lucide-react";
import { type JSX, type ReactNode, useState } from "react";
import { useT } from "../../lib/i18n";
import { useMediaQuery } from "../../lib/useMediaQuery";
import { cn } from "../../lib/utils";
import { DialogContent, DialogRoot, DialogTitle } from "./Dialog";

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
  title?: string;
}

export interface SelectProps<T extends string = string> {
  value: T | undefined;
  onChange: (value: T) => void;
  options: SelectOption<T>[];
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  ariaLabel?: string;
  className?: string;
  searchable?: boolean;
}

const triggerClass =
  "inline-flex min-h-12 w-full items-center justify-between gap-2 rounded-lg border border-input bg-card px-3 py-2.5 text-base text-foreground shadow-sm outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60";

export function Select<T extends string = string>({
  value,
  onChange,
  options,
  placeholder,
  disabled = false,
  id,
  ariaLabel,
  className,
  searchable = false,
}: SelectProps<T>): JSX.Element {
  const t = useT();
  const [open, setOpen] = useState(false);
  // A small anchored popover is lost on a phone screen in a workshop, so below
  // sm the same list opens as a centred dialog instead. One component, two
  // presentations -- this is what org/TouchSelect used to be, and why.
  const isDesktop = useMediaQuery("(min-width: 640px)");

  const selected = options.find((option) => option.value === value);
  const label = selected?.label ?? placeholder ?? t("common.select_placeholder");

  const list: ReactNode = (
    <Command loop>
      {searchable && (
        <div className="mb-1 border-b border-border px-2 pb-1">
          <CommandInput
            placeholder={t("common.search_placeholder")}
            className="min-h-11 w-full bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
      )}
      <CommandList className="max-h-[60vh] overflow-y-auto overscroll-contain sm:max-h-[min(15rem,var(--radix-popover-content-available-height,15rem))]">
        <CommandEmpty className="px-3 py-6 text-center text-sm text-muted-foreground">
          {t("common.no_results")}
        </CommandEmpty>
        <CommandGroup>
          {options.map((option) => (
            <CommandItem
              key={option.value}
              // cmdk filters on `value`; two options sharing a label would
              // otherwise collapse into one row while searching.
              value={`${option.label}\u0000${option.value}`}
              disabled={option.disabled}
              title={option.title}
              onSelect={() => {
                onChange(option.value);
                setOpen(false);
              }}
              className="flex min-h-11 cursor-pointer select-none items-center gap-2 rounded-md px-2.5 text-base text-foreground outline-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50"
            >
              <Check
                className={cn(
                  "size-4 shrink-0",
                  option.value === value ? "opacity-100" : "opacity-0",
                )}
              />
              <span className="truncate">{option.label}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  );

  const triggerBody = (
    <>
      <span className={cn("min-w-0 truncate text-left", !selected && "text-muted-foreground")}>
        {label}
      </span>
      <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
    </>
  );

  if (!isDesktop) {
    return (
      <DialogRoot open={open} onOpenChange={setOpen}>
        <button
          type="button"
          id={id}
          aria-label={ariaLabel}
          disabled={disabled}
          onClick={() => setOpen(true)}
          className={cn(triggerClass, className)}
        >
          {triggerBody}
        </button>
        <DialogContent className="p-2">
          <DialogTitle className="sr-only">{ariaLabel ?? label}</DialogTitle>
          {list}
        </DialogContent>
      </DialogRoot>
    );
  }

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger
        id={id}
        aria-label={ariaLabel}
        disabled={disabled}
        className={cn(triggerClass, className)}
      >
        {triggerBody}
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        {/* --radix-popover-trigger-width matches the panel to the field; the
            version this replaces measured it by hand on every window resize.
            The list is capped at --radix-popover-content-available-height too:
            with a flat 15rem the panel could not fit under a field low in a
            dialog, so Radix flipped it ABOVE the trigger and it covered the
            whole form. Capped, it stays put and scrolls. */}
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          collisionPadding={8}
          className="z-50 w-[var(--radix-popover-trigger-width)] overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
        >
          {list}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
