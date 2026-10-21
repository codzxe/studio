import * as TabsPrimitive from "@radix-ui/react-tabs";
import { type VariantProps, cva } from "class-variance-authority";
import {
  type ComponentProps,
  type ComponentPropsWithoutRef,
  type ComponentRef,
  forwardRef,
} from "react";
import { cn } from "../lib/utils";

/**
 * Tabs — §7.4. Radix Tabs (arrow keys, Home/End, roving focus built in).
 * `underline` for page sections: active tab = paper text + 2px signal
 * underline. `pill` for filters.
 */
export const Tabs = TabsPrimitive.Root;

export const tabsListVariants = cva("inline-flex items-center", {
  variants: {
    variant: {
      underline: "w-full justify-start gap-1 border-b border-border",
      pill: "gap-1 rounded-pill border border-border bg-panel p-1",
    },
  },
  defaultVariants: { variant: "underline" },
});

export const tabsTriggerVariants = cva(
  "inline-flex cursor-pointer select-none items-center justify-center whitespace-nowrap transition-colors duration-120 outline-offset-2 outline-signal disabled:pointer-events-none disabled:text-disabled",
  {
    variants: {
      variant: {
        underline: cn(
          "relative h-9 px-3 text-body-s text-muted hover:text-secondary",
          // 2px signal underline on the active tab (§7.4)
          "after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:bg-signal after:opacity-0 after:transition-opacity after:duration-120",
          "data-[state=active]:text-primary data-[state=active]:after:opacity-100",
        ),
        pill: cn(
          "h-7 rounded-pill px-3 text-body-s text-muted hover:text-secondary",
          "data-[state=active]:bg-elevated data-[state=active]:text-primary",
        ),
      },
    },
    defaultVariants: { variant: "underline" },
  },
);

export interface TabsListProps
  extends ComponentPropsWithoutRef<typeof TabsPrimitive.List>,
    VariantProps<typeof tabsListVariants> {}

export const TabsList = forwardRef<ComponentRef<typeof TabsPrimitive.List>, TabsListProps>(
  function TabsList({ className, variant, ...props }, ref) {
    return (
      <TabsPrimitive.List
        ref={ref}
        className={cn(tabsListVariants({ variant }), className)}
        {...props}
      />
    );
  },
);

export interface TabsTriggerProps
  extends ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>,
    VariantProps<typeof tabsTriggerVariants> {}

export const TabsTrigger = forwardRef<ComponentRef<typeof TabsPrimitive.Trigger>, TabsTriggerProps>(
  function TabsTrigger({ className, variant, ...props }, ref) {
    return (
      <TabsPrimitive.Trigger
        ref={ref}
        className={cn(tabsTriggerVariants({ variant }), className)}
        {...props}
      />
    );
  },
);

export type TabsContentProps = ComponentProps<typeof TabsPrimitive.Content>;

export const TabsContent = forwardRef<ComponentRef<typeof TabsPrimitive.Content>, TabsContentProps>(
  function TabsContent({ className, ...props }, ref) {
    return (
      <TabsPrimitive.Content
        ref={ref}
        className={cn("outline-offset-[-2px]", className)}
        {...props}
      />
    );
  },
);
