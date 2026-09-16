// What a station watches. The screens that write a kind and the screens that
// show one read the same list, so a station never reads as the raw enum on one
// page and as English on another.

export const STATION_KINDS: { value: string; label: string }[] = [
  { value: "provisioning", label: "Tray snapshot counting" },
  { value: "counting", label: "Belt line counting" },
  { value: "compliance", label: "Doorway compliance" },
  { value: "overview", label: "Overview / wall" },
];

export function kindLabel(kind: string): string {
  return STATION_KINDS.find((k) => k.value === kind)?.label ?? kind;
}
