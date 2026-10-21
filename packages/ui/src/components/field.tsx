import { TriangleAlert } from "lucide-react";
import { type ReactNode, useId } from "react";
import { cn } from "../lib/utils";

/** Props spread onto a form control by `Field` (aria wiring, §12). */
export interface FieldControlProps {
  id: string;
  "aria-describedby": string | undefined;
  "aria-invalid": true | undefined;
  required: true | undefined;
}

export interface FieldProps {
  /** Pass an explicit id to keep label ↔ control links stable. */
  id?: string;
  /** Label rendered above the control (12px label style, §7.2). */
  label?: ReactNode;
  /** Helper text, 12px muted (§7.2). Superseded visually by `error`. */
  helperText?: ReactNode;
  /** Error message — danger colour + icon, announced via role="alert". */
  error?: string | null;
  /** Marks control + label as required. */
  required?: boolean;
  /** Control: receives the id + aria attributes to spread. */
  children: (control: FieldControlProps) => ReactNode;
  className?: string;
}

const labelClass = "text-label uppercase tracking-[0.06em] text-secondary";
const helperClass = "text-caption text-muted";

/**
 * Field — label / helper / error wiring for form controls (§7.2, §12).
 * Labels sit above the control (never placeholder-only); helper text and
 * errors link via `aria-describedby`; errors are announced via role="alert".
 *
 * Used internally by Input, Textarea and Select; exported for custom controls.
 */
export function Field({
  id: idProp,
  label,
  helperText,
  error,
  required = false,
  children,
  className,
}: FieldProps) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const helperId = `${id}-helper`;
  const errorId = `${id}-error`;

  const describedBy =
    [helperText ? helperId : null, error ? errorId : null]
      .filter((value): value is string => value !== null)
      .join(" ") || undefined;

  const control = children({
    id,
    "aria-describedby": describedBy,
    "aria-invalid": error ? true : undefined,
    required: required ? true : undefined,
  });

  return (
    <div className={cn("flex w-full flex-col gap-2", className)}>
      {label ? (
        <label htmlFor={id} className={labelClass}>
          {label}
          {required ? (
            <span className="ml-1 text-danger" aria-hidden="true">
              *
            </span>
          ) : null}
        </label>
      ) : null}
      {control}
      {helperText && !error ? (
        <p id={helperId} className={helperClass}>
          {helperText}
        </p>
      ) : null}
      {error ? (
        <p
          id={errorId}
          role="alert"
          className={cn(helperClass, "flex items-center gap-1.5 text-danger")}
        >
          <TriangleAlert size={16} strokeWidth={1.75} aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
