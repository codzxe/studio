# `packages/agent/prompts` — the canonical versioned prompt library

Spec §23: "Store prompts in `packages/agent/prompts/` as versioned files with a
changelog. Every change runs the eval suite. Prompts reference tools by their tool
names only." This directory is that store — the **single source** for every §23
prompt. Owner: W6-L (docs/AGENTS.md).

## Layout

```
prompts/
├── README.md              ← this loading contract
└── v1/                    ← one versioned directory per prompt generation
    ├── CHANGELOG.md       ← change record (spec: "versioned files with a changelog")
    ├── system-executor.md      §23.1 System prompt (executor)
    ├── planner.md              §23.2 Planner prompt
    ├── critic.md               §23.3 Critic prompt (vision)
    ├── repair.md              §23.4 Repair prompt
    └── chat-edit-classifier.md §23.5 Chat-edit classifier (quick tier)
```

## File anatomy

Every `vN/<name>.md` file is:

1. **YAML-ish frontmatter** — `id` (matches the file name), `version`, `source`
   (spec section + line refs), and a `changelog` entry (§23: prompts are versioned,
   every change runs evals).
2. `## Prompt` — the prompt itself inside a single ` ```text ` fenced block. This
   block is the prompt **byte-for-byte**; everything outside the fence is
   documentation.
3. `## Slots` — the interpolation contract (below).
4. `## Mirrors` — the builder/test/evals files that must stay in sync.

## Interpolation — no template engine

Slots are the spec's own `{…}` markers (e.g. `{max_tool_calls}` in §23.1, the
`- BRIEF: {…}` descriptors in §23.2, the `{json array …}` / `{current layer tree …}`
descriptors in §23.4). Substitution is plain string replacement performed at build
time — the TS builders implement it as `template.split("{slot}").join(value)`; a
loader would do the identical `String.replace`-style pass. `${var}` interpolation is
the same plain-substitution idea and **deliberately never appears inside v1 prompt
text**, so the templates stay byte-stable (§5.3 prompt-cache prefix) and
copy-pasteable. §23.3 (critic) and §23.5 (classifier) have **no slots** — their
inputs ride as message payload / multimodal attachments, never inside the template.

## Loading contract

- **The `.md` files are the single source.** Do not fork prompt text into new
  constants, configs or YAML without registering them in the file's `## Mirrors`
  section.
- **Build time / runtime loading**: read the fenced block out of the file — either
  `import prompt from "./prompts/v1/system-executor.md?raw"` (bundler) or
  `fs.readFileSync` + the fence extraction shown in
  `packages/agent/tests/prompts-parity.test.ts` (`extractPromptBlock`), then
  substitute the documented slots. Loading at build time (bundled `?raw`) is
  preferred so deployed bytes are pinned by the build.
- **Today the TS builders embed the text** (`src/executor/prompt.ts`,
  `src/planner/prompt.ts`, `src/repair/prompt.ts` — "the compiled-in mirror") because
  the worker wires them directly; the `.md` files are the editable source of record
  and CI asserts the two never diverge (below). When a real loader lands, it must
  read these same files — never a third copy of the text.
- **Critic + classifier**: the critic §23.3 text is sent verbatim by the worker (W6-E
  seam decision; the vision-critique tool enforces the rules mechanically). The §23.5
  chat-edit builder (`src/classifier/prompt.ts`, W6-O, in flight) embeds the library
  block verbatim as its prompt's closing instruction. Any builder that lands for them
  must render the library file byte-for-byte and join the parity test.

## CI parity (the mirror test)

`packages/agent/tests/prompts-parity.test.ts` asserts the three-legged contract:

1. **library ↔ spec** — each file's fenced block equals the §23.x block of
   `docs/BUILD_PROMPT.md` byte-for-byte (LF-normalized; §23.1 modulo the per-line
   leading-whitespace artifact recorded in `v1/CHANGELOG.md`).
2. **builder ↔ library** — `buildExecutorSystemPrompt`, `buildPlannerPrompt` and
   `buildRepairPrompt` outputs equal the library templates with their documented
   slots substituted (and the repair constants `REPAIR_INTRO_LINE`,
   `REPAIR_FIXES_HEADER`, `REPAIR_CONTEXT_HEADER`, `REPAIR_RULES_TEXT` equal the
   library's fixed lines). If a builder ever diverges structurally, the test falls
   back to comparing the §23 section substrings — coarse but effective.
3. **frontmatter invariants** — `id` matches the file name, `version: 1`, and a
   `changelog` entry exists.

A red parity test means someone edited a prompt outside this library or let the
mirror drift — fix the mirror or ship a properly versioned `v2/`.

## Versioning rules

- Editing a `v1/` prompt **in place is a bug**. To change a prompt: copy the file to
  `v2/<name>.md`, bump its frontmatter `version`, update the text, add a
  `v2/CHANGELOG.md` entry (or a new section in this one), run the eval suite
  (`packages/evals`, §21) and only then point loaders/builders at `v2` — §23:
  "Every change runs the eval suite"; §21's Evals row is the regression gate that
  prompt/model changes must clear before shipping.
- Keep old version directories (evals diff against them; rollbacks need them).

## Relationship to `packages/evals/prompts/*.txt`

Those are **promptfoo variants** — the same §23 text with `{{var}}` markers and an
INPUTS layer for the eval harness. They are eval fixtures, not the canonical source;
the `.md` files here are. Known variant drift (planner's dotted tool ids) is
recorded in `v1/CHANGELOG.md` and belongs to the evals package to fix.
