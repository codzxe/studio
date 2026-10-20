// @studio/ui — presentational base kit (§16.3 shadcn/ui pattern, token-themed).
// Styles live in `./tokens.css` (import it once in the app via `@studio/ui/tokens.css`).

export { cn } from "./lib/cn.js";

export {
  Button,
  buttonVariants,
  type ButtonProps,
} from "./components/button.js";
export {
  Badge,
  badgeVariants,
  STATUS_BADGE_VARIANT,
  statusBadgeVariant,
  type BadgeProps,
  type BadgeVariant,
} from "./components/badge.js";
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
  type DialogContentProps,
} from "./components/dialog.js";
export {
  Input,
  inputVariants,
  useFieldIds,
  type FieldIds,
  type InputProps,
} from "./components/input.js";
export { Label } from "./components/label.js";
export {
  Panel,
  PanelContent,
  PanelHeader,
  PanelResizeHandle,
  type PanelProps,
  type PanelHeaderProps,
  type PanelResizeHandleProps,
  type PanelSide,
} from "./components/panel.js";
export { Skeleton, type SkeletonProps } from "./components/skeleton.js";
export { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/tabs.js";
export {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  type TooltipContentProps,
} from "./components/tooltip.js";
