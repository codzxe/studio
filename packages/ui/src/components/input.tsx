import { type VariantProps, cva } from "class-variance-authority";
import { Search } from "lucide-react";
import { type InputHTMLAttributes, forwardRef } from "react";
import { cn } from "../lib/utils";
import { Field } from "./field";
import { Kbd } from "./kbd";

/** §7.2 — height 36 (sm 32, lg 44), 8px horizontal padding, bg-input, radius-sm. */
export const inputVariants = cva(
  "w-full rounded-sm border bg-input px-2 text-body text-primary transition-colors duration-120 outline-offset-2 placeholder:text-disabled hover:border-border-strong focus-visible:outline-2 focus-visible:outline-signal aria-invalid:border-danger disabled:cursor-not-allowed disabled:opacity-45",
  {
    variants: {
      inputSize: {
        sm: "h-8 text-body-s",
        md: "h-9",
        lg: "h-11",
      },
      hasError: {
        true: "border-danger",
        false: "border-border",
      },
    },
    defaultVariants: {
      inputSize: "md",
      hasError: false,
    },
  },
);

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "size">,
    VariantProps<typeof inputVariants> {
  id?: string;
  label?: string;
  helperText?: string;
  /** Error message — danger colour + icon, linked via aria-describedby. */
  error?: string | null;
}

/**
 * Input — text field with label above, helper + error wiring (§7.2, §12).
 * Focus ring: 2px signal at 2px offset.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { id, label, helperText, error, required, inputSize, hasError, className, ...props },
  ref,
) {
  return (
    <Field id={id} label={label} helperText={helperText} error={error} required={required}>
      {(control) => (
        <input
          ref={ref}
          id={control.id}
          aria-describedby={control["aria-describedby"]}
          aria-invalid={control["aria-invalid"]}
          required={control.required}
          className={cn(inputVariants({ inputSize, hasError: error ? true : hasError }), className)}
          {...props}
        />
      )}
    </Field>
  );
});

export interface SearchInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "type"> {
  id?: string;
  label?: string;
  /** Shortcut hint shown on the trailing edge, e.g. "⌘K" (§7.2). */
  shortcut?: string | null;
  /** Hide the shortcut chip (e.g. inside the command palette). */
  hideShortcut?: boolean;
}

/**
 * SearchInput — leading search icon + `⌘K` hint (§7.2). Wrap in a form or use
 * `onKeyDown` for the shortcut itself; the chip is a hint only.
 */
export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
  { id, label, shortcut = "⌘K", hideShortcut = false, className, required, ...props },
  ref,
) {
  return (
    <Field id={id} label={label} required={required}>
      {(control) => (
        <div className="relative w-full">
          <Search
            size={16}
            strokeWidth={1.75}
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted"
          />
          <input
            ref={ref}
            type="search"
            id={control.id}
            aria-describedby={control["aria-describedby"]}
            aria-invalid={control["aria-invalid"]}
            required={control.required}
            className={cn(
              inputVariants({ inputSize: "md", hasError: false }),
              "pl-8",
              !hideShortcut && shortcut ? "pr-12" : undefined,
              className,
            )}
            {...props}
          />
          {!hideShortcut && shortcut ? (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2"
            >
              <Kbd>{shortcut}</Kbd>
            </span>
          ) : null}
        </div>
      )}
    </Field>
  );
});
