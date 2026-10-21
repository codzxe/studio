import { cn } from "../lib/cn.js";

/**
 * Spinner — inline loading indicator (SVG, `animate-spin`).
 *
 * A11y: a bare spinner is decorative (`aria-hidden`) — pair it with a text label in
 * the UI. Pass `label` to wrap it in a polite live region instead (announced to
 * screen readers), e.g. `<Spinner label="Rendering preview" />` while a run renders.
 */

const SPINNER_SIZE = {
  sm: "size-3.5",
  md: "size-4",
  lg: "size-6",
} as const;

export interface SpinnerProps {
  size?: keyof typeof SPINNER_SIZE;
  /**
   * Accessible name — wraps the spinner in `role="status"` with an sr-only label
   * (polite announcement). Without a label the spinner is hidden from AT.
   */
  label?: string;
  className?: string;
}

export function Spinner({ size = "md", label, className }: SpinnerProps) {
  const svg = (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cn("animate-spin text-current", SPINNER_SIZE[size], className)}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" className="opacity-20" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
  if (label === undefined) return svg;
  return (
    <span role="status" className="inline-flex items-center gap-2">
      {svg}
      <span className="sr-only">{label}</span>
    </span>
  );
}
