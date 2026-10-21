import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * Custom type-scale tokens (§4.2). Without this extension, tailwind-merge
 * cannot tell `text-body-s` (font-size) apart from `text-primary` (colour) and
 * would drop one of them when merging classes.
 */
export const typeScaleTokens = [
  "display-xl",
  "display-l",
  "display-m",
  "title-l",
  "title-m",
  "body-l",
  "body",
  "body-s",
  "label",
  "caption",
  "mono",
  "hint",
] as const;

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: typeScaleTokens as unknown as string[] }],
    },
  },
});

/** Merge class names — Tailwind-aware (last conflicting class wins). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
