---
id: repair
version: 1
source: docs/BUILD_PROMPT.md §23.4 Repair prompt, lines 1784–1801
changelog:
  v1 (2026-10-21) — initial extraction from spec §23.4, VERBATIM (fenced block is
  byte-for-byte §23 text; the FIXES array line and the CONTEXT descriptor are the only
  interpolating slots). Mirrors packages/agent/src/repair/prompt.ts buildRepairPrompt.
  Any change to this prompt ships as v2/ + a CHANGELOG.md entry + a green eval run
  (§23, §21).
---

# repair · v1 · §23.4 Repair prompt

The fenced block below is the **verbatim** §23.4 template. Do not reword, reflow or
reorder it. Called at most MAX_REPAIR_CYCLES (2, §5.1) times per run; the planning phase
appends its own reply contract AFTER this prompt (see Mirrors) — this file stays the one
source of §23.4 text.

## Prompt

```text
A validated render has issues. Apply the minimum fixes; change nothing else.

FIXES:
{json array of critic/validator issues with layer, fix}

CONTEXT: {current layer tree, template manifest, palette, validator report}

Rules:
- One fix at a time, smallest tool that works (text_set, layer_ops, style_apply, layout_apply).
- Do not restructure, rename, add or delete layers unless a fix explicitly requires it.
- After applying, call render_preview and validate_document; reply with JSON:
  {"applied":[{"issue":"code","tool":"...","result":"ok|failed","note":"..."}]}
- If a fix is impossible with available tools, say so and propose the closest valid
  alternative; never leave the document in a worse state than before.
```

## Slots

Plain substitution, no template engine (`${var}` interpolation is the same
plain-substitution idea and deliberately never appears inside v1 prompt text). The two
`{…}` descriptors below are replaced by the builder; every other character is fixed
§23.4 text.

| Slot | Line | Interpolates | Wired by |
|---|---|---|---|
| `{json array of critic/validator issues with layer, fix}` | the whole line under `FIXES:` | `JSON.stringify(fixes)` — array of `{code, layer?, fix}` (≤5, blocker/major only, blockers first; `code` rides so rule 3's echo can name it) | `buildRepairPrompt` (packages/agent/src/repair/prompt.ts) |
| `{current layer tree, template manifest, palette, validator report}` | after `CONTEXT: ` | one-line JSON object `{"layerTree","manifest"("none" when absent),"palette"([] when absent),"validatorReport"}` | same builder |

Every embedded string is §15.3-stripped of control characters at the builder boundary;
caps mirror the critic seam (4000/4000/2000 chars, ≤10 palette entries).

## Mirrors

- Builder: `packages/agent/src/repair/prompt.ts` — `REPAIR_INTRO_LINE`,
  `REPAIR_FIXES_HEADER`, `REPAIR_CONTEXT_HEADER`, `REPAIR_RULES_TEXT` and
  `buildRepairPrompt` render this file byte-for-byte.
- Planning-phase seam: `src/repair/planner.ts` appends its `{"applied":[…]}`
  reply contract AFTER the rendered prompt — the §23.4 text here is reused unmodified
  by the applying phase.
- Parity: `packages/agent/tests/prompts-parity.test.ts` pins this file against spec
  §23.4 and the builder output.
- No promptfoo variant in packages/evals yet (repair evals ride the §21 suite when
  repair cases land).
