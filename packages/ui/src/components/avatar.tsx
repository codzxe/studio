import * as AvatarPrimitive from "@radix-ui/react-avatar";
import type { HTMLAttributes } from "react";
import { cn } from "../lib/utils";

export interface AvatarProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  /** Initials are derived from the name (initials only — no photos in v1). */
  name: string;
  size?: "sm" | "md" | "lg";
}

const avatarSizeClass = {
  sm: "h-6 w-6 text-hint",
  md: "h-8 w-8 text-body-s",
  lg: "h-10 w-10 text-body",
} as const;

function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .slice(0, 2);
  const chars = words.map((word) => word.charAt(0).toUpperCase());
  return chars.length > 0 ? chars.join("") : "?";
}

/**
 * Avatar — initials only, pill radius (§8.1: "no fake avatars; use initials").
 * The name doubles as the accessible label via role="img".
 */
export function Avatar({ name, size = "md", className, ...props }: AvatarProps) {
  return (
    <AvatarPrimitive.Root
      role="img"
      aria-label={name}
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-pill border border-border bg-input font-medium text-secondary select-none",
        avatarSizeClass[size],
        className,
      )}
      {...props}
    >
      <AvatarPrimitive.Fallback delayMs={0}>{initialsOf(name)}</AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}
