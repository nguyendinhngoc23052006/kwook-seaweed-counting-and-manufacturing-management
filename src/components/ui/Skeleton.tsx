// A skeleton is a promise about what is coming. The word "Đang tải…" is not:
// it looks identical to a page that has silently failed, which is exactly how
// the forever-loading unit dashboard hid a missing branch for three weeks.
export function Skeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={`animate-pulse rounded-md bg-hairline ${className ?? ""}`} />
  );
}

// Every Skeleton block is aria-hidden, so without a label this live region
// has no content to announce and a screen reader gets silence where a sighted
// reader gets a clear "something is coming".
export function ListSkeleton({ rows = 3, label }: { rows?: number; label?: string }) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label ?? "Đang tải…"}
      className="divide-y divide-hairline"
      data-testid="list-skeleton"
    >
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 py-4">
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
          <Skeleton className="h-4 w-12" />
        </div>
      ))}
    </div>
  );
}
