---
id: planner
version: 1
source: docs/BUILD_PROMPT.md §23.2 Planner prompt, lines 1709–1747
changelog:
  v1 (2026-10-21) — initial extraction from spec §23.2, VERBATIM (fenced block is
  byte-for-byte §23 text; the five `Inputs:` brace descriptors are the only
  interpolating slots). Mirrors packages/agent/src/planner/prompt.ts buildPlannerPrompt.
  Any change to this prompt ships as v2/ + a CHANGELOG.md entry + a green eval run
  (§23, §21).
---

# planner · v1 · §23.2 Planner prompt

The fenced block below is the **verbatim** §23.2 template. Do not reword, reflow or
reorder it. Note the §5.1 one-retry attachment is APPENDED after the rendered prompt by
`buildPlannerRetryPrompt` — the §23.2 text itself is never edited for a retry.

## Prompt

```text
You are planning one design-agent run.

Inputs:
- BRIEF: {user prompt, attachments, export target, prior conversation}
- SNAPSHOT: {canvas, layer tree, template slots, palette, fonts}
- CATALOG: {templates with tags and slots, components with variables}
- BUDGET: {tier, max tokens, max tool calls, max revisions}
- RULES: {validator checks, brand tokens}

Choose the smallest path to a correct, on-brand, editable document:
- If a template matches the intent, choose it and fill slots.
- Else if components + layout primitives can express it, plan that.
- Else plan a freeform composition from primitives (last resort, flag it).

Return JSON only, validated by the provided schema:
{
  "intent": "create_post|edit_layers|resize|variant|export",
  "template": "id@version or null",
  "assets": [{"ref":"asset_id","slot":"photo","fit":"cover","focal":{"x":0.5,"y":0.4}}],
  "slots": {"slot": "value"},
  "palette": ["#hex", ...],
  "typography": {"headline":{"font":"display","weight":"bold"}},
  "steps": [{"tool":"template_apply","args":{}}, {"tool":"template_fill","args":{}}],
  "checks": ["in_bounds","contrast>=4.5","headline_largest","safe_area"],
  "model_tier": "quick|standard|complex",
  "notes_for_user": "one sentence"
}

Rules:
- Prefer template > components+layout > freeform.
- Never invent slot names, component variables, or asset ids not present in CATALOG/SNAPSHOT.
- Keep text within slot maxChars; write shorter, punchier copy when in doubt.
- If the brief is ambiguous in a way that changes the outcome (language, product, logo),
  include {"tool":"ask_user","args":{...}} as the first step.
- Do not include raw pixel coordinates in slots; layout solves geometry.
```

## Slots

The five `Inputs:` lines are labeled sections. The `{…}` descriptor after each label is
NOT a literal runtime placeholder — the builder replaces the **entire descriptor** with
the compact JSON block of the worker-assembled section (plain `JSON.stringify`
substitution — no template engine; `${var}` interpolation is the same plain-substitution
idea and deliberately never appears inside v1 prompt text).

| Slot line | Descriptor (verbatim) | Interpolates | Wired by |
|---|---|---|---|
| `- BRIEF: ` | `{user prompt, attachments, export target, prior conversation}` | `JSON.stringify(sections.brief)` (§5.4) | `buildPlannerPrompt` (packages/agent/src/planner/prompt.ts) |
| `- SNAPSHOT: ` | `{canvas, layer tree, template slots, palette, fonts}` | `JSON.stringify(sections.snapshot)` | same builder |
| `- CATALOG: ` | `{templates with tags and slots, components with variables}` | `JSON.stringify(sections.catalog)` — carries the §6.1 tool manifest (names + descriptions only) | same builder |
| `- BUDGET: ` | `{tier, max tokens, max tool calls, max revisions}` | `JSON.stringify(sections.budget)` — §5.2 tier row | same builder |
| `- RULES: ` | `{validator checks, brand tokens}` | `JSON.stringify(sections.rules)` — §11.1 check ids + brand tokens | same builder |

What rides in each section is §5.4's context-assembly job (the worker's); this template
only labels + stringifies. Everything else in the fenced block is fixed §23.2 text.

## Mirrors

- Builder: `packages/agent/src/planner/prompt.ts` — `buildPlannerPrompt` renders this
  template with the five sections interpolated; `buildPlannerRetryPrompt` appends §5.1
  validation issues AFTER it.
- Parity: `packages/agent/tests/prompts-parity.test.ts` pins this file against spec
  §23.2 and the builder output.
- promptfoo variant: `packages/evals/prompts/planner.system.txt` (same text with
  promptfoo `{{brief}}/{{snapshot}}/{{catalog}}/{{budget}}/{{rules}}` markers — eval
  harness layer only, never the canonical source).
- Known divergence in that evals variant: its example `steps` uses dotted tool ids
  (`template.apply`); §23.2 and this file use the canonical `template_apply` form
  (§5.5/§6 tool ids). The evals package owns fixing its variant.
