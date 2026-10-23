/**
 * Textarea — §7.2 example gallery (documentation-as-code).
 *
 * Default rows, helper + error wiring, and the chat-style auto-grow in one
 * token-styled file. Typecheck-only docs — never run by vitest.
 */
import { useState } from "react";
import { Textarea } from "./textarea";

const labelClass = "text-label uppercase tracking-[0.06em] text-muted";

export default function TextareaExample() {
  const [brief, setBrief] = useState("");

  return (
    <section
      aria-label="Textarea examples"
      className="flex max-w-xl flex-col gap-8 rounded-md border border-border bg-panel p-6"
    >
      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Default — min 3 rows (§7.2)</h3>
        <Textarea
          id="ex-brief"
          label="Brief"
          placeholder="A neon title over the city skyline."
          helperText="One sentence is enough."
        />
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Taller brief</h3>
        <Textarea id="ex-script" label="Script notes" rows={6} />
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Error — announced via role=alert (§12)</h3>
        <Textarea id="ex-error" label="Brief" error="Say what to build." />
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Auto-grow — chat composer style (controlled value)</h3>
        <Textarea
          id="ex-autogrow"
          label="Message the agent"
          autoGrow
          value={brief}
          onChange={(event) => setBrief(event.target.value)}
          placeholder="Add a title over the second beat…"
        />
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Required + disabled</h3>
        <Textarea id="ex-required" label="Handoff notes" required />
        <Textarea id="ex-disabled" label="Locked brief" disabled defaultValue="Frozen at v4." />
      </div>
    </section>
  );
}
