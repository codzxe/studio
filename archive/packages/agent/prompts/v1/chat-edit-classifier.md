---
id: chat-edit-classifier
version: 1
source: docs/BUILD_PROMPT.md §23.5 Chat-edit classifier (quick tier), lines 1803–1813
changelog:
  v1 (2026-10-21) — initial extraction from spec §23.5, VERBATIM (fenced block is
  byte-for-byte §23 text; no slots — the user's edit request rides as the message, not
  in the prompt). Builder landing in flight (W6-O src/classifier/prompt.ts) embeds the
  block verbatim as its closing instruction. Any change ships as v2/ + a CHANGELOG.md
  entry + a green eval run (§23, §21).
---

# chat-edit-classifier · v1 · §23.5 Chat-edit classifier (quick tier)

The fenced block below is the **verbatim** §23.5 template. Do not reword, reflow or
reorder it. It classifies a targeted edit request on an existing document so the quick
tier never pays for a regeneration (§24.2).

## Prompt

```text
Classify the user's edit request on an existing document. Return JSON only:
{"action":"set_text|replace_field|restyle|move|resize|add_component|remove_layer|recolor|export|clarify",
 "target_layers":["name"], "args":{...}, "cost_tier":"quick|standard|complex",
 "needs_template_reapply":true|false}
Pick the cheapest action that satisfies the request. If the target is ambiguous, list
candidates and set action "clarify" with one question. Never propose a full regeneration
when a targeted edit works.
```

## Slots

**None.** The §23.5 text has no `{slot}` markers: the user's edit request (plus the
document context the runtime attaches) is supplied as the message payload — never
interpolated into this template.

## Mirrors

- Builder (in flight, W6-O): `packages/agent/src/classifier/prompt.ts` renders a
  composite prompt — labeled context sections + worker output conventions — with this
  file's §23.5 block VERBATIM as the closing instruction (its header pins against this
  library file). It must keep the block byte-equal and join
  `packages/agent/tests/prompts-parity.test.ts` when it lands (the spec-parity leg below
  already pins this file).
- Parity: `packages/agent/tests/prompts-parity.test.ts` pins this file against spec
  §23.5.
- No promptfoo variant in packages/evals yet (classifier evals ride the §21 suite when
  chat-edit cases land).
