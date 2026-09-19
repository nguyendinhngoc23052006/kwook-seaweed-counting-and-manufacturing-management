import { useSyncExternalStore } from "react";

// useSyncExternalStore, not useState+useEffect: the first render already gets
// the right answer, so a select does not flash as a popover before becoming a
// dialog on a phone.
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
