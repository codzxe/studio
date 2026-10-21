import * as MenuPrimitive from "@radix-ui/react-dropdown-menu";
import { type ComponentPropsWithoutRef, type ComponentRef, forwardRef } from "react";
import { cn } from "../lib/utils";

/**
 * Menu — §7.6. Radix DropdownMenu: item height 32, icon 16, shortcut
 * right-aligned in mono 11px (§4.2: the only 11px text in the app).
 * Full keyboard support (arrows, Home/End, Esc, type-ahead) from Radix.
 */
export const Menu = MenuPrimitive.Root;
export const MenuTrigger = MenuPrimitive.Trigger;
export const MenuGroup = MenuPrimitive.Group;
export const MenuRadioGroup = MenuPrimitive.RadioGroup;
export const MenuCheckboxItem = MenuPrimitive.CheckboxItem;
export const MenuItemIndicator = MenuPrimitive.ItemIndicator;
export const MenuRadioItem = MenuPrimitive.RadioItem;

export const MenuContent = forwardRef<
  ComponentRef<typeof MenuPrimitive.Content>,
  ComponentPropsWithoutRef<typeof MenuPrimitive.Content>
>(function MenuContent({ className, sideOffset = 6, ...props }, ref) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          "z-50 min-w-48 overflow-hidden rounded-md border border-border bg-elevated p-1 text-body-s shadow-pop",
          "data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out",
          className,
        )}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
});

export const MenuItem = forwardRef<
  ComponentRef<typeof MenuPrimitive.Item>,
  ComponentPropsWithoutRef<typeof MenuPrimitive.Item>
>(function MenuItem({ className, ...props }, ref) {
  return (
    <MenuPrimitive.Item
      ref={ref}
      className={cn(
        "flex h-8 cursor-default select-none items-center gap-2 rounded-xs px-2 text-body-s text-secondary outline-none transition-colors duration-120",
        "data-highlighted:bg-input data-highlighted:text-primary",
        "data-disabled:pointer-events-none data-disabled:text-disabled",
        className,
      )}
      {...props}
    />
  );
});

/** Right-aligned shortcut hint — mono 11px (§7.6). */
export const MenuItemShortcut = forwardRef<HTMLSpanElement, ComponentPropsWithoutRef<"span">>(
  function MenuItemShortcut({ className, ...props }, ref) {
    return (
      <span
        ref={ref}
        aria-hidden="true"
        className={cn("ml-auto pl-8 font-mono text-hint text-muted", className)}
        {...props}
      />
    );
  },
);

export const MenuLabel = forwardRef<
  ComponentRef<typeof MenuPrimitive.Label>,
  ComponentPropsWithoutRef<typeof MenuPrimitive.Label>
>(function MenuLabel({ className, ...props }, ref) {
  return (
    <MenuPrimitive.Label
      ref={ref}
      className={cn("px-2 py-1.5 text-label uppercase tracking-[0.06em] text-muted", className)}
      {...props}
    />
  );
});

export const MenuSeparator = forwardRef<
  ComponentRef<typeof MenuPrimitive.Separator>,
  ComponentPropsWithoutRef<typeof MenuPrimitive.Separator>
>(function MenuSeparator({ className, ...props }, ref) {
  return (
    <MenuPrimitive.Separator
      ref={ref}
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
});
