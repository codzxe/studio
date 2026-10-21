import { type Ref, type TextareaHTMLAttributes, useLayoutEffect, useState } from "react";
import { cn } from "../lib/utils";
import { Field } from "./field";

/**
 * useAutoGrow — grows a controlled textarea to fit its content (§7.2:
 * auto-grow in chat). Pass the current `value`; the hook keeps layout stable
 * by sizing to scrollHeight (no animated layout shift).
 */
export function useAutoGrow(value: unknown): (node: HTMLTextAreaElement | null) => void {
  const [node, setNode] = useState<HTMLTextAreaElement | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `value` is the deliberate resize trigger; the body reads only the DOM node
  useLayoutEffect(() => {
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${node.scrollHeight}px`;
  }, [node, value]);

  return setNode;
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** React 19: ref is a regular prop. */
  ref?: Ref<HTMLTextAreaElement>;
  id?: string;
  label?: string;
  helperText?: string;
  error?: string | null;
  /** Grow the textarea to fit content (controlled `value` required). */
  autoGrow?: boolean;
}

/**
 * Textarea — min 3 rows (§7.2). With `autoGrow` and a controlled value, the
 * height follows the content. Label above, helper + error wiring as Input.
 */
export function Textarea({
  ref,
  id,
  label,
  helperText,
  error,
  required,
  autoGrow = false,
  value,
  className,
  rows = 3,
  ...props
}: TextareaProps) {
  const autoGrowRef = useAutoGrow(value);
  return (
    <Field id={id} label={label} helperText={helperText} error={error} required={required}>
      {(control) => (
        <textarea
          ref={autoGrow ? autoGrowRef : ref}
          id={control.id}
          aria-describedby={control["aria-describedby"]}
          aria-invalid={control["aria-invalid"]}
          required={control.required}
          rows={rows}
          value={value}
          className={cn(
            "w-full resize-none rounded-sm border bg-input px-2 py-2 text-body text-primary transition-colors duration-120 outline-offset-2 placeholder:text-disabled hover:border-border-strong focus-visible:outline-2 focus-visible:outline-signal aria-invalid:border-danger disabled:cursor-not-allowed disabled:opacity-45",
            error ? "border-danger" : "border-border",
            autoGrow ? "overflow-hidden" : undefined,
            className,
          )}
          {...props}
        />
      )}
    </Field>
  );
}
