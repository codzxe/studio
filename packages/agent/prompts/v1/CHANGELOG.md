# Prompt library changelog — v1

Per spec §23: "Store prompts in `packages/agent/prompts/` as versioned files with a
changelog. Every change runs the eval suite. Prompts reference tools by their tool
names only." This file is the change record for the `v1/` directory. Never edit `v1/`
files in place — ship `v2/` + an entry here + a green eval run.

## v1 — 2026-10-21 — initial extraction from spec §23 (W6-L)

One file per prompt, content **verbatim** from `docs/BUILD_PROMPT.md` §23 (fenced
```text blocks; variable slots marked and documented per file):

| File | Spec section | Source lines (BUILD_PROMPT.md) | TS builder mirror |
|---|---|---|---|
| `system-executor.md` | §23.1 System prompt (executor) | 1676–1707 | `src/executor/prompt.ts` (W6-B) |
| `planner.md` | §23.2 Planner prompt | 1709–1747 | `src/planner/prompt.ts` (W6-A) |
| `critic.md` | §23.3 Critic prompt (vision) | 1749–1782 | none in-package — worker sends verbatim (W6-E decision; tool-side enforcement in packages/tools) |
| `repair.md` | §23.4 Repair prompt | 1784–1801 | `src/repair/prompt.ts` (W6-F) |
| `chat-edit-classifier.md` | §23.5 Chat-edit classifier (quick tier) | 1803–1813 | `src/classifier/prompt.ts` (W6-O, in flight) — embeds the §23.5 block verbatim as its closing instruction |

### Extraction notes

- The raw `docs/BUILD_PROMPT.md` file is CRLF-encoded and begins with a paste-marker
  line; §23 prompt bytes canonicalize to LF (the encoding all TS builders and the
  parity test use).
- §23.1 known divergence: the raw spec block hanging-indents 8 wrapped continuation
  lines of rules 1–10 (3–4 leading spaces); the shipped `EXECUTOR_SYSTEM_PROMPT_TEMPLATE`
  (W6-B, already pinned by executor tests) dedents them, so `system-executor.md` matches
  the shipped template byte-for-byte and the spec modulo per-line leading whitespace.
  Flagged to the W6-B builder owner; reconciling toward the raw indents would be a v2.
- §23.2: the five `Inputs:` brace descriptors are interpolation slots — the builder
  replaces the entire descriptor with the section's compact JSON. The
  `packages/evals/prompts/planner.system.txt` promptfoo variant still shows dotted
  tool ids (`template.apply`) in its example `steps`; §23.2 and this library use the
  canonical `template_apply` (§5.5/§6) form. The evals package owns fixing its variant.
- Byte-verification for everything above runs in CI:
  `packages/agent/tests/prompts-parity.test.ts` (library file ↔ spec §23.x ↔ builder
  output — the three committed builders executor/planner/repair are called directly;
  critic is worker-verbatim and the in-flight classifier builder joins it when it
  lands).

### Evals coupling (§23 / §21)

Prompts are versioned and **every prompt/model change ships only with an eval pass**:
§23 requires "Every change runs the eval suite", and §21's Evals layer (promptfoo,
50+ golden briefs, assertions on plan validity / validator results / layer names /
slot contents / render similarity / tier cost, regression gate) is that suite — see
`packages/evals`. The parity test below guards *accidental* drift (library ↔ spec ↔
builders); the eval suite guards *behavioral* drift. Neither replaces the other, and
an eval pass must be green before any `v2/` directory is pointed at by a loader.
