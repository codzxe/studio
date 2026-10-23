/**
 * Toast — §7.7 example gallery (documentation-as-code).
 *
 * Bottom-right viewport, variants default/success/warning/danger, title +
 * optional description, ONE action max, close control. Typecheck-only docs —
 * never run by vitest.
 */
import { useState } from "react";
import { Button } from "./button";
import {
  TOAST_DURATION_MS,
  Toast,
  ToastAction,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "./toast";

const labelClass = "text-label uppercase tracking-[0.06em] text-muted";

export default function ToastExample() {
  const [open, setOpen] = useState(false);

  return (
    <ToastProvider>
      <section
        aria-label="Toast examples"
        className="flex max-w-xl flex-col gap-8 rounded-md border border-border bg-panel p-6"
      >
        <div className="flex flex-col gap-3">
          <h3 className={labelClass}>Firing a success toast — one action max (§7.7)</h3>
          <Button onClick={() => setOpen(true)}>Save version</Button>
        </div>

        <div className="flex flex-col gap-3">
          <h3 className={labelClass}>All variants docked (static gallery)</h3>
          <ul className="flex w-[min(360px,100%)] flex-col gap-2">
            <li>
              <Toast open variant="default" duration={TOAST_DURATION_MS}>
                <ToastTitle>Version 4 saved</ToastTitle>
                <ToastDescription>Autosaved 12s ago.</ToastDescription>
                <ToastClose />
              </Toast>
            </li>
            <li>
              <Toast open variant="success" duration={TOAST_DURATION_MS}>
                <ToastTitle>Render finished</ToastTitle>
                <ToastDescription>titles-v4.mp4 · 00:12 · 12.4 MB</ToastDescription>
                <ToastAction asChild altText="Open the render">
                  <button type="button">Open</button>
                </ToastAction>
                <ToastClose />
              </Toast>
            </li>
            <li>
              <Toast open variant="warning" duration={TOAST_DURATION_MS}>
                <ToastTitle>Credits running low</ToastTitle>
                <ToastDescription>950 of 1,000 credits used this cycle.</ToastDescription>
                <ToastClose />
              </Toast>
            </li>
            <li>
              <Toast open variant="danger" duration={TOAST_DURATION_MS}>
                <ToastTitle>Render failed</ToastTitle>
                <ToastDescription>Missing asset: footage/beach.mp4.</ToastDescription>
                <ToastClose />
              </Toast>
            </li>
          </ul>
        </div>
      </section>

      {/* The live example, docked bottom-right by the viewport (§7.7). */}
      <Toast open={open} onOpenChange={setOpen} variant="success" duration={TOAST_DURATION_MS}>
        <ToastTitle>Version 4 saved</ToastTitle>
        <ToastDescription>Restored from 12s ago.</ToastDescription>
        <ToastAction asChild altText="Undo the save">
          <button type="button">Undo</button>
        </ToastAction>
        <ToastClose />
      </Toast>
      <ToastViewport />
    </ToastProvider>
  );
}
