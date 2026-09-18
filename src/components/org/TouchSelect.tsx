import { ChevronDown } from "lucide-react";
import { type JSX, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { Dialog } from "../ui/Dialog";
import type { SelectProps } from "../ui/Select";

// A small anchored popover is lost on a phone screen in a workshop — a
// centered, scrollable dialog is easier to hit and to read. min-h-12/text-base
// on the trigger and min-h-11 on each row match the 44px floor Button,
// Checkbox and ListRow already keep.
export function TouchSelect<T extends string = string>(props: SelectProps<T>): JSX.Element {
  const {
    value,
    onChange,
    options,
    placeholder,
    disabled = false,
    id,
    ariaLabel,
    className = "",
    searchable = false,
  } = props;

  const t = useT();
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [searchTerm, setSearchTerm] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  const selectedLabel =
    options.find((opt) => opt.value === value)?.label ||
    placeholder ||
    t("common.select_placeholder");

  const filteredOptions = searchable
    ? options.filter((opt) => (opt.label ?? "").toLowerCase().includes(searchTerm.toLowerCase()))
    : options;

  const handleClose = () => {
    setOpen(false);
    setSearchTerm("");
  };

  const handleOpen = () => {
    if (disabled) return;
    setOpen(true);
    setSearchTerm("");
    setHighlightedIndex(0);
  };

  const handleSelect = (optionValue: T) => {
    onChange(optionValue);
    handleClose();
  };

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchTerm(e.currentTarget.value);
    setHighlightedIndex(0);
  };

  const handleListKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlightedIndex((prev) => (prev < filteredOptions.length - 1 ? prev + 1 : prev));
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : 0));
        break;
      case "Enter": {
        e.preventDefault();
        const selected = filteredOptions[highlightedIndex];
        if (selected && !selected.disabled) handleSelect(selected.value);
        break;
      }
      case "Escape":
        // Dialog's content wrapper stops keydown propagation (so a keypress
        // inside it can't bubble to the backdrop's close-on-click-outside),
        // which also blocks Dialog's own document-level Escape listener from
        // ever seeing this key — handle it here instead.
        e.preventDefault();
        handleClose();
        break;
    }
  };

  // This also covers the trigger, which keeps DOM focus (and so keeps
  // receiving keydowns) whenever the dialog opens without
  // a search input to steal it.
  const handleTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handleOpen();
      }
      return;
    }
    handleListKeyDown(e);
  };

  useLayoutEffect(() => {
    if (open && searchable) searchInputRef.current?.focus();
  }, [open, searchable]);

  return (
    <div className={className}>
      <button
        type="button"
        id={id}
        aria-label={ariaLabel}
        onClick={handleOpen}
        onKeyDown={handleTriggerKeyDown}
        disabled={disabled}
        className={`inline-flex w-full min-h-12 items-center justify-between rounded-md border border-brand-hairline px-3 py-2 text-base shadow-sm transition ${
          disabled
            ? "cursor-not-allowed bg-brand-cream-light text-brand-muted"
            : "bg-surface-raised text-brand-ink hover:bg-brand-cream-light focus:border-brand-navy focus:outline-none focus:ring-1 focus:ring-brand-navy"
        }`}
      >
        <span>{selectedLabel}</span>
        <ChevronDown size={16} className="ml-2 flex-shrink-0" />
      </button>
      <Dialog
        open={open}
        onClose={handleClose}
        title={ariaLabel || placeholder || t("common.select_placeholder")}
      >
        <div onKeyDown={handleListKeyDown}>
          {searchable && (
            <input
              ref={searchInputRef}
              type="text"
              placeholder={t("common.search_placeholder")}
              value={searchTerm}
              onChange={handleSearchChange}
              className="mb-3 block w-full rounded-md border border-brand-hairline px-3 py-2 text-sm shadow-sm focus:border-brand-navy focus:outline-none focus:ring-1 focus:ring-brand-navy"
            />
          )}
          <ul className="max-h-[60vh] overflow-y-auto">
            {filteredOptions.map((option, idx) => (
              <li
                key={option.value}
                aria-selected={option.value === value}
                title={option.title}
                onClick={() => {
                  if (!option.disabled) handleSelect(option.value);
                }}
                onKeyDown={(e) => {
                  if ((e.key === "Enter" || e.key === " ") && !option.disabled) {
                    e.preventDefault();
                    handleSelect(option.value);
                  }
                }}
                className={`flex min-h-11 items-center rounded-md px-3 text-base ${
                  idx === highlightedIndex ? "bg-brand-cream-light" : ""
                } ${
                  option.disabled
                    ? "cursor-not-allowed text-brand-muted"
                    : "cursor-pointer text-brand-ink hover:bg-brand-cream-light"
                } ${option.value === value ? "bg-brand-cream-light font-medium" : ""}`}
              >
                {option.label}
              </li>
            ))}
          </ul>
        </div>
      </Dialog>
    </div>
  );
}
