import { type JSX, useState } from "react";
import { useT } from "../../lib/i18n";
import { Button } from "../ui/Button";

export interface ArchivedRow {
  id: string;
  title: string;
  subtitle?: string;
}

// The only place hidden things exist in the app, and the way back from a
// mis-click. Without it "delete" is a one-way door that only a hand-written
// query can reopen.
//
// It renders nothing when there is nothing hidden, so it costs a reader who
// has never hidden anything exactly zero attention -- and for anyone who is
// not the sysadmin or the CEO the rows never arrive in the first place,
// because the read policy filters them, not this component.
export function ArchivedDisclosure({
  rows,
  onRestore,
  restoring,
  hint,
}: {
  rows: ArchivedRow[];
  onRestore: (id: string) => void;
  restoring?: boolean;
  hint?: string;
}): JSX.Element | null {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;

  return (
    <div className="border-t border-hairline pt-4">
      <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? t("archive.hide_list") : t("archive.show_list", { count: rows.length })}
      </Button>
      {open && (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-ink-faint">{hint ?? t("archive.hint")}</p>
          {rows.map((row) => (
            <div
              key={row.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-hairline bg-surface-raised p-3"
            >
              <div className="min-w-0">
                <div className="truncate font-medium text-ink">{row.title}</div>
                {row.subtitle && (
                  <div className="truncate text-xs text-ink-faint">{row.subtitle}</div>
                )}
              </div>
              <Button
                size="sm"
                variant="secondary"
                disabled={restoring}
                onClick={() => onRestore(row.id)}
              >
                {t("archive.restore")}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
