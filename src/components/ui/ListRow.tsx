import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "../../lib/utils";

// The whole row is the target. A row can also carry its own action (Rename,
// Remove), and that action must NOT be nested inside the navigating anchor:
// `<a><button></a>` is invalid content per the HTML model, and preventDefault
// on the button only suppresses a plain left-click. Middle-click, ctrl-click
// and right-click are handled by the browser against the <a href> itself and
// never reach the button's handler, so "Rename" would silently open the row in
// a new tab.
//
// So the anchor wraps only the title and stretches over the row with an inset
// pseudo-element; `trailing` is a sibling with its own stacking context, above
// that overlay. One anchor, no nesting, every click modifier lands on whichever
// control the pointer is actually over.
interface Props {
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  leading?: ReactNode;
  to?: string;
  onClick?: () => void;
  trailing?: ReactNode;
}

// min-h-14 is 56px: comfortably past the 44px touch floor, and it holds a
// two-line Vietnamese title without the diacritics clipping.
function Chevron() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className="size-4 shrink-0 text-muted-foreground"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M7 4l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const stretched = "before:absolute before:inset-0 before:content-[''] before:rounded-lg";

export function ListRow({ title, subtitle, meta, leading, to, onClick, trailing }: Props) {
  const interactive = Boolean(to || onClick);

  const titleNode = to ? (
    <Link to={to} className={cn("font-medium text-foreground outline-none", stretched)}>
      {title}
    </Link>
  ) : onClick ? (
    <button
      type="button"
      onClick={onClick}
      className={cn("text-left font-medium text-foreground outline-none", stretched)}
    >
      {title}
    </button>
  ) : (
    <span className="font-medium text-foreground">{title}</span>
  );

  return (
    <div
      className={cn(
        "relative -mx-4 flex min-h-14 w-[calc(100%+2rem)] items-center gap-3 rounded-lg px-4 py-3 text-left sm:-mx-5 sm:w-[calc(100%+2.5rem)] sm:px-5",
        interactive &&
          "transition-colors hover:bg-accent focus-within:bg-accent focus-within:ring-[3px] focus-within:ring-ring/40",
      )}
    >
      {leading && <div className="relative shrink-0">{leading}</div>}
      <div className="min-w-0 flex-1">
        {/* title= is the only recovery a truncated name has on a touch device,
            and Vietnamese runs ~30% longer than the English these widths were
            eyeballed against. */}
        <div className="truncate" title={typeof title === "string" ? title : undefined}>
          {titleNode}
        </div>
        {subtitle && (
          <div
            className="mt-0.5 truncate text-sm text-muted-foreground"
            title={typeof subtitle === "string" ? subtitle : undefined}
          >
            {subtitle}
          </div>
        )}
      </div>
      {meta && <div className="relative shrink-0 text-sm text-muted-foreground">{meta}</div>}
      {trailing && <div className="relative shrink-0">{trailing}</div>}
      {interactive && <Chevron />}
    </div>
  );
}

export function ListRows({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-border">{children}</div>;
}
