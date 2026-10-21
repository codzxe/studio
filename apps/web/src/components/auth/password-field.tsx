"use client";

import { Field, cn, inputVariants } from "@studio/ui";
import { Eye, EyeOff } from "lucide-react";
import { type InputHTMLAttributes, useState } from "react";

/**
 * Password input with show/hide (§8.2): the Field wrapper from @studio/ui
 * (label above, helper/error wiring, role=alert) around a plain input plus a
 * trailing eye toggle — 32px hit area, aria-pressed, never the only cue.
 */

export interface PasswordFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "type" | "className"> {
  id: string;
  label: string;
  error?: string | null;
  helperText?: string;
}

export function PasswordField({
  id,
  label,
  error,
  helperText,
  required,
  ...props
}: PasswordFieldProps) {
  const [show, setShow] = useState(false);

  return (
    <Field id={id} label={label} helperText={helperText} error={error} required={required}>
      {(control) => (
        <div className="relative">
          <input
            id={control.id}
            type={show ? "text" : "password"}
            aria-describedby={control["aria-describedby"]}
            aria-invalid={control["aria-invalid"]}
            required={control.required}
            autoComplete={props.autoComplete ?? "current-password"}
            className={cn(inputVariants({ inputSize: "lg", hasError: Boolean(error) }), "pr-11")}
            {...props}
          />
          <button
            type="button"
            onClick={() => setShow((value) => !value)}
            aria-label={show ? "Hide password" : "Show password"}
            aria-pressed={show}
            className="absolute top-1/2 right-1 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-sm text-muted transition-colors duration-120 hover:bg-elevated hover:text-primary"
          >
            {show ? (
              <EyeOff size={16} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <Eye size={16} strokeWidth={1.75} aria-hidden="true" />
            )}
          </button>
        </div>
      )}
    </Field>
  );
}
