import type { ReactNode } from "react";
import { Link } from "react-router-dom";

// The whole row is the target. The screenshot this replaces put a 28px-wide
// blue "Mở" at the far right of a 1400px row: the only tappable pixels were
// the ones furthest from the thumb, and the row itself -- the thing that
// looks like the object -- did nothing.
//
// A row can also carry its own action (Rename, Remove). That action must NOT
// be nested inside the navigating anchor: `<a><button></a>` is invalid content
// per the HTML model, and preventDefault on the button only suppresses a plain
// left-click. Middle-click, ctrl/cmd-click and right-click are handled by the
// browser against the <a href> itself and never reach the button's handler, so
// "Rename" would silently open the sector in a new tab.
//
// So the anchor wraps only the title, and stretches over the row with an
// inset pseudo-element. `trailing` is a sibling with its own stacking context,
// above that overlay. One anchor, no nesting, and every click modifier lands on
// whichever control the pointer is actually over.
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
const shell =
  "relative flex w-full items-center gap-3 py-3 min-h-14 text-left -mx-4 px-4 sm:-mx-5 sm:px-5";

function Chevron() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className="size-4 shrink-0 text-ink-faint"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M7 4l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ListRow({ title, subtitle, meta, leading, to, onClick, trailing }: Props) {
  const interactive = Boolean(to || onClick);

  const titleNode = to ? (
    // before:absolute before:inset-0 is the stretched-link: the anchor's own
    // hit area covers the row, so there is nothing to nest.
    <Link
      to={to}
      className="font-medium text-ink before:absolute before:inset-0 before:content-['']"
    >
      {title}
    </Link>
  ) : onClick ? (
    <button
      type="button"
      onClick={onClick}
      className="text-left font-medium text-ink before:absolute before:inset-0 before:content-['']"
    >
      {title}
    </button>
  ) : (
    <span className="font-medium text-ink">{title}</span>
  );

  return (
    <div
      className={`${shell} ${interactive ? "transition-colors hover:bg-surface-muted focus-within:bg-surface-muted" : ""}`}
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
            className="mt-0.5 truncate text-sm text-ink-muted"
            title={typeof subtitle === "string" ? subtitle : undefined}
          >
            {subtitle}
          </div>
        )}
      </div>
      {meta && <div className="relative shrink-0 text-sm text-ink-muted">{meta}</div>}
      {trailing && <div className="relative shrink-0">{trailing}</div>}
      {interactive && <Chevron />}
    </div>
  );
}

export function ListRows({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-hairline">{children}</div>;
}
