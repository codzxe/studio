import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import {
  type ComponentProps,
  type ComponentPropsWithoutRef,
  type ComponentRef,
  type ReactNode,
  forwardRef,
} from "react";
import { cn } from "../lib/utils";
import { Field } from "./field";

/**
 * Select — Radix Select styled to §7.2 (custom popover on desktop; native
 * mobile rendering is a v2 concern — Radix everywhere for v1). Trigger matches
 * the Input sizing (36 / sm 32 / lg 44), bg-input, radius-sm; the listbox is
 * bg-elevated, radius-md, elevation 1.
 */
export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectLabel = SelectPrimitive.Label;
export const SelectSeparator = SelectPrimitive.Separator;

export interface SelectTriggerProps
  extends Omit<ComponentProps<typeof SelectPrimitive.Trigger>, "id" | "size"> {
  id?: string;
  label?: string;
  helperText?: string;
  error?: string | null;
  /** Radix Select.Trigger does not accept the HTML `required` attribute — we forward it to the form context only. */
  required?: boolean;
  triggerSize?: "sm" | "md" | "lg";
  placeholder?: string;
  children?: ReactNode;
}

const triggerSizeClass = {
  sm: "h-8 text-body-s",
  md: "h-9",
  lg: "h-11",
} as const;

export const SelectTrigger = forwardRef<HTMLButtonElement, SelectTriggerProps>(
  function SelectTrigger(
    {
      id,
      label,
      helperText,
      error,
      required,
      triggerSize = "md",
      placeholder,
      className,
      children,
      ...props
    },
    ref,
  ) {
    return (
      <Field id={id} label={label} helperText={helperText} error={error} required={required}>
        {(control) => (
          <SelectPrimitive.Trigger
            ref={ref}
            id={control.id}
            aria-describedby={control["aria-describedby"]}
            aria-invalid={control["aria-invalid"]}
            aria-required={control.required ?? undefined}
            className={cn(
              "flex w-full items-center justify-between gap-2 rounded-sm border bg-input px-2 text-body text-primary transition-colors duration-120 outline-offset-2 hover:border-border-strong focus-visible:outline-2 focus-visible:outline-signal aria-invalid:border-danger data-placeholder:text-disabled disabled:cursor-not-allowed disabled:opacity-45",
              error ? "border-danger" : "border-border",
              triggerSizeClass[triggerSize],
              className,
            )}
            {...props}
          >
            {children ?? <SelectPrimitive.Value placeholder={placeholder ?? "Select"} />}
            <ChevronDown
              size={16}
              strokeWidth={1.75}
              aria-hidden="true"
              className="shrink-0 text-muted"
            />
          </SelectPrimitive.Trigger>
        )}
      </Field>
    );
  },
);

export const SelectValue = SelectPrimitive.Value;

export const SelectContent = forwardRef<
  ComponentRef<typeof SelectPrimitive.Content>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(function SelectContent(
  { className, children, position = "popper", sideOffset = 6, ...props },
  ref,
) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        position={position}
        sideOffset={sideOffset}
        className={cn(
          "z-50 max-h-72 min-w-[8rem] overflow-hidden rounded-md border border-border bg-elevated p-1 text-body-s shadow-pop data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out",
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport className="max-h-[min(24rem,var(--radix-select-content-available-height))]">
          {children}
        </SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
});

export interface SelectItemProps extends ComponentPropsWithoutRef<typeof SelectPrimitive.Item> {
  shortcut?: string;
}

export const SelectItem = forwardRef<ComponentRef<typeof SelectPrimitive.Item>, SelectItemProps>(
  function SelectItem({ className, children, ...props }, ref) {
    return (
      <SelectPrimitive.Item
        ref={ref}
        className={cn(
          "relative flex h-8 w-full cursor-default select-none items-center rounded-xs pr-8 pl-2 text-body-s text-secondary outline-none data-highlighted:bg-input data-highlighted:text-primary data-disabled:pointer-events-none data-disabled:text-disabled",
          className,
        )}
        {...props}
      >
        <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
        <span className="absolute right-2 flex h-4 w-4 items-center justify-center">
          <SelectPrimitive.ItemIndicator>
            <Check size={16} strokeWidth={1.75} aria-hidden="true" className="text-primary" />
          </SelectPrimitive.ItemIndicator>
        </span>
      </SelectPrimitive.Item>
    );
  },
);
