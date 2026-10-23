/**
 * @studio/ui — dark cinematic design system (docs/UI_DESIGN_SYSTEM.md).
 * Standalone: no app imports. Dark-only. Semantic tokens only.
 *
 * CSS import contract (app globals.css):
 *   @import "tailwindcss";
 *   @import "@studio/ui/src/styles/theme.css";
 *   @source "<repo>/packages/ui/src";
 * See packages/ui/README.md for fonts (next/font) wiring.
 */

/** CSS entrypoints shipped by this package. */
export const css = {
  tokens: "@studio/ui/src/styles/tokens.css",
  theme: "@studio/ui/src/styles/theme.css",
  utilities: "@studio/ui/src/styles/utilities.css",
} as const;

export { cn, typeScaleTokens } from "./lib/utils";

export { Field, type FieldControlProps, type FieldProps } from "./components/field";
export { Kbd } from "./components/kbd";
export { Spinner, type SpinnerProps } from "./components/spinner";

export {
  Button,
  buttonVariants,
  type ButtonProps,
} from "./components/button";
export {
  Input,
  SearchInput,
  inputVariants,
  type InputProps,
  type SearchInputProps,
} from "./components/input";
export { Textarea, useAutoGrow, type TextareaProps } from "./components/textarea";
export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  type SelectItemProps,
  type SelectTriggerProps,
} from "./components/select";

export {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  ProjectCard,
  type ProjectCardProps,
} from "./components/card";

export {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  tabsListVariants,
  tabsTriggerVariants,
  type TabsContentProps,
  type TabsListProps,
  type TabsTriggerProps,
} from "./components/tabs";

export {
  ConfirmDialog,
  Dialog,
  DialogActions,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
  type ConfirmDialogProps,
  type DialogContentProps,
} from "./components/dialog";

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "./components/popover";
export {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuItemIndicator,
  MenuItemShortcut,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "./components/menu";
export {
  TOOLTIP_DELAY_MS,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./components/tooltip";
export {
  TOAST_DURATION_MS,
  Toast,
  ToastAction,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
  toastVariants,
  type ToastProps,
} from "./components/toast";

export {
  Badge,
  RiskBadge,
  StatusDot,
  badgeVariants,
  type BadgeProps,
  type RiskBadgeProps,
  type RiskLevel,
  type StatusDotProps,
  type StatusTone,
} from "./components/badge";

export {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
  type TableCellProps,
  type TableEmptyProps,
  type TableHeadProps,
  type TableProps,
  type TableRowProps,
} from "./components/table";

export {
  CommandPalette,
  type CommandGroup,
  type CommandItem,
  type CommandPaletteProps,
} from "./components/command-palette";
export { CreditMeter, type CreditMeterProps, type CreditState } from "./components/credit-meter";
export { EmptyState, type EmptyStateProps } from "./components/empty-state";
export { Skeleton } from "./components/skeleton";
export { FrameLine, type FrameLineProps } from "./components/frame-line";
export { Avatar, type AvatarProps } from "./components/avatar";
