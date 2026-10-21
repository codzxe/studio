import type { ComponentProps } from "react";
import { cn } from "../lib/cn.js";

/**
 * Switch — on/off toggle built on a NATIVE checkbox (deliberately not a JS button):
 * - Space/Enter toggling, checked-state announcement and form submission are free
 * - `role="switch"` maps the checked state to the switch semantics screen readers expect
 * - focus ring + hover/disabled states are drawn via `peer-*` utilities on the track
 *   and thumb, which sit next to the (invisible but focusable) checkbox overlay.
 *
 * The overlay checkbox also makes the whole control one big hit target.
 */
export interface SwitchProps
  extends Omit<ComponentProps<"input">, "type" | "children" | "checked" | "defaultChecked"> {
  /** Controlled on/off. */
  checked?: boolean;
  /** Initial on/off for uncontrolled usage. */
  defaultChecked?: boolean;
  /** Change handler receiving the next on/off state (fires alongside native onChange). */
  onCheckedChange?: (checked: boolean) => void;
}

export function Switch({
  className,
  checked,
  defaultChecked,
  onCheckedChange,
  onChange,
  disabled,
  ...props
}: SwitchProps) {
  return (
    <span className="relative inline-flex shrink-0 items-center">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        defaultChecked={defaultChecked}
        disabled={disabled}
        onChange={(event) => {
          onChange?.(event);
          onCheckedChange?.(event.currentTarget.checked);
        }}
        className="peer absolute inset-0 z-10 size-full cursor-pointer appearance-none opacity-0 focus-visible:outline-none disabled:cursor-not-allowed"
        {...props}
      />
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none flex h-5 w-9 items-center rounded-full border-2 border-transparent bg-input transition-colors",
          "peer-checked:border-transparent peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background peer-disabled:opacity-50",
          className,
        )}
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-0.5 size-4 -translate-y-1/2 rounded-full bg-foreground shadow transition-transform duration-200 peer-checked:translate-x-4 peer-checked:bg-primary-foreground"
      />
    </span>
  );
}
