// A station's kind is the owner's own word for what the place IS, not what a
// camera computes there - that is the session's camera_function. The list below
// is only a starting vocabulary; the floor names itself.

export const KIND_SUGGESTIONS: string[] = [
  "Belt",
  "Tray table",
  "Doorway",
  "Wash bay",
  "Packing table",
  "Cold store",
  "Loading bay",
];

export function kindLabel(kind: string): string {
  return kind.trim() || "Unspecified";
}
