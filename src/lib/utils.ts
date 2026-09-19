import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

// shadcn/ui's class merger: clsx resolves conditionals, tailwind-merge makes a
// later utility beat an earlier one of the same family so a caller's className
// can always override a component's default.
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
