import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "cmdk";
import { Check, ChevronDown } from "lucide-react";
import { type JSX, useState } from "react";
import { useT } from "../../lib/i18n";
import { cn } from "../../lib/utils";

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

// Radix Popover + cmdk. Replaces two hand-rolled listboxes (this one and
// org/TouchSelect) that each re-implemented outside-click, window-resize
// repositioning and arrow-key navigation, and neither of which announced
// itself to a screen reader.
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
  const selected = options.find((o) => o.value === value);

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger
        id={id}
        aria-label={ariaLabel}
        disabled={disabled}
        className={cn(
          "inline-flex min-h-12 w-full items-center justify-between gap-2 rounded-lg border border-input bg-card px-3 py-2.5 text-base text-foreground shadow-sm outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60",
          !selected && "text-muted-foreground",
          className,
        )}
      >
        <span className="truncate text-left">
          {selected?.label ?? placeholder ?? t("common.select_placeholder")}
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
      </PopoverPrimitive.Trigger>

      <PopoverPrimitive.Portal>
        {/* --radix-popover-trigger-width matches the panel to the field; the
            version this replaces measured it by hand on every window resize. */}
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          className="z-50 w-[var(--radix-popover-trigger-width)] overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
        >
          <Command loop>
            {searchable && (
              <div className="mb-1 border-b border-border px-2 pb-1">
                <CommandInput
                  placeholder={t("common.search_placeholder")}
                  className="min-h-11 w-full bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground"
                />
              </div>
            )}
            <CommandList className="max-h-60 overflow-y-auto overscroll-contain">
              <CommandEmpty className="px-3 py-6 text-center text-sm text-muted-foreground">
                {t("common.no_results")}
              </CommandEmpty>
              <CommandGroup>
                {options.map((option) => (
                  <CommandItem
                    key={option.value}
                    value={option.label}
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
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
