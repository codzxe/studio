"use client";

import { useState } from "react";

/**
 * FaqItem — one accessible accordion row for the /faq page (§8.1 §9, M9-E).
 *
 * Keyboard operable by construction (a real `<button>`), `aria-expanded` +
 * `aria-controls` on the trigger, the panel is a labelled `region`, and the
 * answer stays in the DOM (hidden, not removed) so `aria-controls` targets are
 * stable. The answer can carry links — it is `ReactNode`, not plain text.
 */

export function FaqItem({
  id,
  question,
  answer,
  defaultOpen = false,
}: {
  /** Stable id suffix for the button/panel pair. */
  id: string;
  question: string;
  answer: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const buttonId = `faq-trigger-${id}`;
  const panelId = `faq-panel-${id}`;
  return (
    <div data-testid={`faq-item-${id}`} className="border-b border-border">
      <h2>
        <button
          id={buttonId}
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
          className="flex w-full cursor-pointer items-center justify-between gap-6 py-5 text-left text-body text-primary transition-colors duration-120 hover:text-signal"
        >
          <span>{question}</span>
          <span
            aria-hidden="true"
            className={`text-muted transition-transform duration-180 ease-out ${open ? "rotate-45" : ""}`}
          >
            +
          </span>
        </button>
      </h2>
      <section
        id={panelId}
        aria-labelledby={buttonId}
        hidden={!open}
        className="max-w-[80ch] pb-5 text-body-s leading-relaxed text-secondary"
      >
        {answer}
      </section>
    </div>
  );
}
