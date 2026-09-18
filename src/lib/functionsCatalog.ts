import type { CameraFunction } from "./session";

// The functions a camera can be configured to run. Only seaweed counting
// exists today; future functions (QA/QC compliance, idle detection, ...) are
// added HERE as the vision core grows - a new row in this catalog (and its
// mirror check in the pair-claim Edge Function) is the only change needed.
export const FUNCTIONS: { value: CameraFunction; label: string }[] = [
  { value: "counting", label: "Count seaweed leaves" },
];

export function functionLabel(cameraFunction: string): string {
  return FUNCTIONS.find((f) => f.value === cameraFunction)?.label ?? cameraFunction;
}
