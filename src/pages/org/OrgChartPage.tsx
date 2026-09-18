import { useQuery } from "@tanstack/react-query";
import {
  type JSX,
  type MouseEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "react-router-dom";
import { Empty, ErrorState } from "../../components/ui/EmptyState";
import { Input } from "../../components/ui/Input";
import { Pill } from "../../components/ui/Pill";
import { ListSkeleton } from "../../components/ui/Skeleton";
import { errorMessage } from "../../lib/errorMessage";
import { useI18n } from "../../lib/i18n";
import { natureLabelFor, nodeLabel } from "../../lib/orgLabels";
import {
  ancestorsToExpand,
  buildSearchIndex,
  childrenOf,
  getOrgTree,
  indexChildren,
  listNodeNatures,
  matchingNodeIds,
  type NodeNature,
  type OrgTreeNode,
} from "../../services/nodes";

// Same depth cap the SQL walks and breadcrumbOf() use: the triggers refuse a
// cycle unconditionally, so this is pure insurance against a hypothetical
// direct-SQL data corruption bypassing that guard -- not a real org-size limit.
const MAX_DEPTH = 100000;

// How deep the chart opens on arrival. The layout is a nested flex tree, so a
// subtree's width is the sum of its leaves': at a few hundred boxes, drawing
// everything is many screens of sideways scrolling before you have read
// anything. Two levels is the company and its divisions, which is what an
// overview is for; the rest opens on ask.
const OPEN_TO_DEPTH = 2;

// How long to let someone keep typing before a keystroke recomputes matches
// and re-lays-out the tree. Matching itself is a substring scan over a
// pre-folded index (built once per snapshot, not per keystroke) so this exists
// for typing feel, not for search speed.
const SEARCH_DEBOUNCE_MS = 150;

// Bigger than natural hand tremor (1-2px) between mousedown and mouseup, small
// enough that a deliberate drag reads as a drag immediately.
const DRAG_THRESHOLD_PX = 6;

type DragState = {
  active: boolean;
  moved: boolean;
  pointerId: number;
  startX: number;
  startY: number;
  startScrollLeft: number;
  startScrollTop: number;
};

// Classic (non-overlay) scrollbars have no DOM node of their own -- a
// pointerdown on the track/thumb still targets this pane, so without this
// check drag-to-pan would fight the browser's own thumb-drag.
function isOnNativeScrollbar(pane: HTMLDivElement, e: PointerEvent<HTMLDivElement>): boolean {
  return e.nativeEvent.offsetX >= pane.clientWidth || e.nativeEvent.offsetY >= pane.clientHeight;
}

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2;

// CSS `zoom` (not `transform: scale`) on purpose: `transform` doesn't shrink
// or grow the element's contribution to its scrollable ancestor's overflow --
// the native scrollbar and this page's own scrollLeft/scrollTop math would
// stay sized for the un-zoomed content. `zoom` changes real layout size, so
// both stay correct for free. Supported in every evergreen browser since
// Firefox 126 (May 2024) -- Chrome 4+, Edge 12+, Safari 4+, Firefox 126+.
//
// PERFORMANCE: `zoom` is layout-affecting, and `.org-tree` can hold hundreds
// of real nodes with connector-line pseudo-elements -- writing it, or
// scrollLeft/scrollTop, synchronously on every raw pointermove/wheel event
// forces a reflow per event. A trackpad or a fast mouse fires those events
// far quicker than a large tree can re-lay-out, so the main thread falls
// behind: input queues up (feels like the drag is unresponsive, including on
// the expand/collapse buttons, which share the same thread) and then drains
// in a burst once it catches up (feels like the drag "jumps"). Both handlers
// below batch their actual DOM read/write into at most one
// requestAnimationFrame callback, coalescing however many raw events arrived
// since the last paint into a single reflow.
const rafBatch = (pendingRef: { current: number | null }, run: () => void) => {
  if (pendingRef.current !== null) return;
  pendingRef.current = requestAnimationFrame(() => {
    pendingRef.current = null;
    run();
  });
};

function seatLines(node: OrgTreeNode): OrgTreeNode["seats"] {
  return [...node.seats].sort((a, b) => a.rank_ordinal - b.rank_ordinal).slice(0, 3);
}

function NodeBox({
  node,
  natures,
  locale,
  t,
  matched,
}: {
  node: OrgTreeNode;
  natures: NodeNature[];
  locale: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
  matched: boolean;
}) {
  const nature = natureLabelFor(natures, node.nature, locale);
  const shown = seatLines(node);
  const staffed = node.seats.filter((seat) => seat.person_id).length;

  return (
    <Link
      to={`/org/node/${node.id}`}
      // Every box tiles the pane, so most drags start on top of one. An <a>
      // is natively draggable in Chromium/Firefox/Safari -- without this,
      // that starts the browser's own drag-and-drop gesture instead of our
      // pointer-based pan, which fires a pointercancel and kills the drag
      // outright (most real drags begin on a node box, not empty space).
      draggable={false}
      className={`inline-block min-w-44 max-w-64 rounded-lg border bg-surface-raised px-3 py-2 text-left shadow-sm transition hover:border-accent hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
        matched ? "border-accent ring-2 ring-accent/40" : "border-hairline"
      }`}
    >
      <div className="text-sm font-bold text-ink">{nodeLabel(node, locale)}</div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {nature && <Pill tone="accent">{nature}</Pill>}
        {!node.active && <Pill tone="danger">{t("orgtree.inactive")}</Pill>}
        <Pill>{t("orgtree.counts", { seats: node.seats.length, staffed })}</Pill>
      </div>
      {shown.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {shown.map((seat) => (
            <li key={seat.position_id} className="text-xs leading-snug">
              <span className="text-ink-muted">{seat.title}</span>{" "}
              <span className={seat.person_name ? "font-medium text-ink" : "text-ink-faint"}>
                {seat.person_name ?? t("orgtree.seat_vacant")}
              </span>
            </li>
          ))}
          {node.seats.length > shown.length && (
            <li className="text-xs text-ink-faint">
              {t("orgchart.more_seats", {
                count: node.seats.length - shown.length,
              })}
            </li>
          )}
        </ul>
      )}
    </Link>
  );
}

function Branch({
  node,
  index,
  natures,
  locale,
  t,
  depth,
  opened,
  onToggle,
  matchedIds,
  searching,
}: {
  node: OrgTreeNode;
  index: Map<string, OrgTreeNode[]>;
  natures: NodeNature[];
  locale: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
  depth: number;
  opened: Set<string>;
  onToggle: (id: string) => void;
  matchedIds: Set<string>;
  searching: boolean;
}): JSX.Element {
  const children = depth < MAX_DEPTH ? childrenOf(index, node.id) : [];
  // While searching, the search's own expand set is authoritative -- it is
  // exactly the ancestors of every match, so opening anything else would
  // either hide a match (too little) or defeat the point of collapsing
  // everything that didn't match (too much).
  const show = searching ? opened.has(node.id) : depth < OPEN_TO_DEPTH || opened.has(node.id);
  const buried = countBelow(index, node.id);
  return (
    <li>
      <NodeBox
        node={node}
        natures={natures}
        locale={locale}
        t={t}
        matched={matchedIds.has(node.id)}
      />
      {children.length > 0 && !searching && (
        <button
          type="button"
          onClick={() => onToggle(node.id)}
          aria-expanded={show}
          className="mt-1 inline-flex min-h-8 items-center rounded-full border border-hairline bg-surface-raised px-3 text-xs font-medium text-accent-text transition hover:border-accent"
        >
          {show ? t("orgchart.collapse") : t("orgchart.expand", { count: buried })}
        </button>
      )}
      {children.length > 0 && show && (
        <ul>
          {children.map((child) => (
            <Branch
              key={child.id}
              node={child}
              index={index}
              natures={natures}
              locale={locale}
              t={t}
              depth={depth + 1}
              opened={opened}
              onToggle={onToggle}
              matchedIds={matchedIds}
              searching={searching}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// How many boxes are hidden under this one, so the button can say what opening
// it costs rather than making you find out.
function countBelow(index: Map<string, OrgTreeNode[]>, id: string): number {
  let n = 0;
  const stack = [...(index.get(id) ?? [])];
  while (stack.length > 0 && n < 9999) {
    const next = stack.pop();
    if (!next) break;
    n += 1;
    stack.push(...(index.get(next.id) ?? []));
  }
  return n;
}

// The whole organisation as one picture, drawn from the same org_tree()
// snapshot the node browser reads. Every box is a link into that box, so the
// chart is a way to work with the tree rather than a poster of it.
export function OrgChartPage(): JSX.Element {
  const { t, locale } = useI18n();
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) =>
    setOpened((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  // Drag-to-pan (mouse only -- touch already gets this for free from native
  // scrolling) and wheel-to-zoom, on the same bounded scroll pane. State
  // lives in refs, not React state, and the actual DOM read/write is batched
  // to at most once per animation frame (see the PERFORMANCE comment above
  // `rafBatch`) so a fast drag or a rapid wheel-zoom never falls behind real
  // input.
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<DragState>({
    active: false,
    moved: false,
    pointerId: -1,
    startX: 0,
    startY: 0,
    startScrollLeft: 0,
    startScrollTop: 0,
  });
  const zoomRef = useRef(1);
  const panRafId = useRef<number | null>(null);
  const pendingPan = useRef<{ pane: HTMLDivElement; dx: number; dy: number } | null>(null);
  const zoomRafId = useRef<number | null>(null);
  const pendingWheel = useRef<{ clientX: number; clientY: number; deltaYSum: number } | null>(null);

  function applyPendingPan() {
    const pending = pendingPan.current;
    pendingPan.current = null;
    if (!pending || !dragRef.current.active) return;
    pending.pane.scrollLeft = dragRef.current.startScrollLeft - pending.dx;
    pending.pane.scrollTop = dragRef.current.startScrollTop - pending.dy;
  }

  function handlePointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    const pane = e.currentTarget;
    if (isOnNativeScrollbar(pane, e)) return;
    // Deliberately NOT calling setPointerCapture or preventDefault yet: a
    // captured pointer retargets its eventual click to the capturing element
    // (this pane), so calling it unconditionally here breaks every plain
    // click on a NodeBox Link or the expand/collapse button, dragged or not.
    // Both are deferred to handlePointerMove, once a real drag is confirmed.
    dragRef.current = {
      active: true,
      moved: false,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startScrollLeft: pane.scrollLeft,
      startScrollTop: pane.scrollTop,
    };
  }

  function handlePointerMove(e: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag.active || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
      drag.moved = true;
      setIsDragging(true);
      // Only capture once this is confirmed to be a real drag: keeps
      // receiving pointermove even if the cursor leaves the pane mid-drag,
      // without touching the click semantics of a plain, undragged click.
      e.currentTarget.setPointerCapture(e.pointerId);
      e.preventDefault();
    }
    if (drag.moved) {
      pendingPan.current = { pane: e.currentTarget, dx, dy };
      rafBatch(panRafId, applyPendingPan);
    }
  }

  function endDrag(e: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (e.pointerId !== drag.pointerId) return;
    drag.active = false;
    if (drag.moved) setIsDragging(false);
  }

  function handleClickCapture(e: MouseEvent<HTMLDivElement>) {
    if (dragRef.current.moved) {
      e.preventDefault();
      e.stopPropagation();
      dragRef.current.moved = false;
    }
  }

  // A callback ref, not useRef+useEffect: the pane conditionally unmounts and
  // remounts whenever a search toggles the noResults branch below, and React
  // never re-runs an effect with an empty dependency array just because the
  // DOM node a plain ref points to was swapped -- the listener would end up
  // attached to a detached node after the first remount. A callback ref
  // re-fires (cleanup, then setup) on every mount/unmount of the node it's
  // given, which is exactly the lifecycle this needs. Also native (not React
  // synthetic): React attaches onWheel passively, so preventDefault() inside
  // a JSX onWheel handler is silently ignored -- this is the standard
  // workaround every wheel-zoom implementation uses.
  const attachPane = useCallback((pane: HTMLDivElement | null) => {
    if (!pane) return;
    const inner = pane.querySelector<HTMLDivElement>(".org-tree");
    if (!inner) return;

    // Fresh mount: start at 100% regardless of whatever zoom a previous,
    // now-unmounted pane instance had left in the ref, so the ref and the
    // (also fresh) DOM node's implicit zoom:1 never disagree.
    zoomRef.current = 1;
    inner.style.zoom = "1";

    function applyPendingWheel() {
      if (!pane || !inner) return;
      const pending = pendingWheel.current;
      pendingWheel.current = null;
      if (!pending) return;
      const oldZoom = zoomRef.current;
      // Proportional to the accumulated delta so a trackpad's many small
      // continuous events and a mouse wheel's few bigger ones both feel
      // smooth, regardless of how many raw events landed in this one frame.
      const factor = Math.exp(-pending.deltaYSum * 0.001);
      const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, oldZoom * factor));
      if (newZoom === oldZoom) return;

      // Keep the point under the cursor fixed on screen: convert its
      // position to tree-content space at the old zoom, then re-derive the
      // scroll offset that puts that same content point back under the
      // cursor at the new zoom. One rect read, one style write, one scroll
      // write -- for the whole frame, not per raw wheel event.
      const rect = pane.getBoundingClientRect();
      const pointerX = pending.clientX - rect.left;
      const pointerY = pending.clientY - rect.top;
      const contentX = (pane.scrollLeft + pointerX) / oldZoom;
      const contentY = (pane.scrollTop + pointerY) / oldZoom;

      zoomRef.current = newZoom;
      inner.style.zoom = String(newZoom);
      pane.scrollLeft = contentX * newZoom - pointerX;
      pane.scrollTop = contentY * newZoom - pointerY;
    }

    function handleWheel(e: WheelEvent) {
      e.preventDefault();
      const existing = pendingWheel.current;
      if (existing) {
        existing.deltaYSum += e.deltaY;
        existing.clientX = e.clientX;
        existing.clientY = e.clientY;
      } else {
        pendingWheel.current = { clientX: e.clientX, clientY: e.clientY, deltaYSum: e.deltaY };
      }
      rafBatch(zoomRafId, applyPendingWheel);
    }

    pane.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      pane.removeEventListener("wheel", handleWheel);
      if (panRafId.current !== null) cancelAnimationFrame(panRafId.current);
      if (zoomRafId.current !== null) cancelAnimationFrame(zoomRafId.current);
      panRafId.current = null;
      zoomRafId.current = null;
      pendingPan.current = null;
      pendingWheel.current = null;
    };
  }, []);

  const tree = useQuery({ queryKey: ["org", "tree"], queryFn: getOrgTree });
  const natures = useQuery({
    queryKey: ["org", "node-natures"],
    queryFn: listNodeNatures,
  });

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const nodes = tree.data ?? [];
  // Rebuilt only when the snapshot changes, not per keystroke -- matching
  // itself is then a plain substring scan over already-folded text.
  const searchIndex = useMemo(() => buildSearchIndex(nodes), [nodes]);
  const matchedIds = useMemo(
    () => matchingNodeIds(searchIndex, debouncedQuery),
    [searchIndex, debouncedQuery],
  );
  const searchExpand = useMemo(() => ancestorsToExpand(nodes, matchedIds), [nodes, matchedIds]);
  const searching = debouncedQuery.trim().length > 0;

  if (tree.isLoading) return <ListSkeleton rows={4} label={t("orgtree.loading")} />;
  if (tree.isError) {
    return <ErrorState message={errorMessage(tree.error, t("orgtree.load_failed"))} />;
  }

  const index = indexChildren(nodes);
  const roots = nodes.filter((n) => n.parent_id === null);
  if (roots.length === 0) {
    return <Empty title={t("orgtree.empty")} description={t("orgtree.empty_hint")} />;
  }

  const noResults = searching && matchedIds.size === 0;

  return (
    <div className="flex h-full min-h-0 flex-col space-y-4">
      <div>
        <h1 className="font-display text-2xl font-bold text-ink">{t("orgchart.title")}</h1>
        <p className="text-sm text-ink-muted">{t("orgchart.hint")}</p>
      </div>

      <div className="max-w-sm">
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("orgchart.search_placeholder")}
          aria-label={t("orgchart.search_placeholder")}
        />
        {searching && !noResults && (
          <p className="mt-1 text-xs text-ink-muted">
            {t("orgchart.search_count", { count: matchedIds.size })}
          </p>
        )}
      </div>

      {noResults ? (
        <Empty title={t("orgchart.search_empty")} description={t("orgchart.search_empty_hint")} />
      ) : (
        <div
          ref={attachPane}
          className={`min-h-0 flex-1 overflow-auto pb-4 ${
            isDragging ? "cursor-grabbing select-none" : "cursor-grab"
          }`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onClickCapture={handleClickCapture}
        >
          <div className="org-tree min-w-max">
            <ul>
              {roots.map((root) => (
                <Branch
                  key={root.id}
                  node={root}
                  index={index}
                  natures={natures.data ?? []}
                  locale={locale}
                  t={t}
                  depth={1}
                  opened={searching ? searchExpand : opened}
                  onToggle={toggle}
                  matchedIds={matchedIds}
                  searching={searching}
                />
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
