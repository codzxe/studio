import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge conditional + variant class names (clsx) and resolve Tailwind utility
 * conflicts (tailwind-merge). This is the single className combiner used by
 * every component in the kit so consumer `className` overrides always win.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
