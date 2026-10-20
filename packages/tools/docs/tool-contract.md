# The tool contract, as enforced reality (§6.1)

Audited against the Wave 5 tree at commit `1182b2a` ("W5-H: layer_ops tool") plus
the in-flight working-tree additions that landed during this audit — W5-R's
`ask-user.ts` + `registry-defaults.ts` + the `index.ts` barrel rewrite, W5-O's
`vision-critique.ts` + `validate-document.ts`, and W5-L's `component-set-vars.ts`
(uncommitted at audit time; marked **[in-flight]** below).
Every statement below is backed by code in this package — the kit (`src/kit.ts`),
the seam and envelope types (`src/types.ts`), the registry (`src/registry.ts`),
and the tool files in `src/tools/`. Where a §6.1 rule is a *promise* rather than
a mechanism, this document says so. The spec (`docs/BUILD_PROMPT.md` §6.1) is the
law; this file is the witness statement of how the current tool implementations
comply.

Companions: `README.md` (author-facing contract summary) and `tool-coverage.md`
(the §6 surface audit: which tools exist, which engine commands they emit, which
tests pin them).

---

## 1. Strict argument schemas — `additionalProperties: false`, everywhere

- `src/kit.ts` re-exports **`strictObject`** (a plain alias of `z.strictObject`). Every
  tool builds its args schema from `strictObject` atoms — no *args* schema uses
  `z.object` (the three `z.object` sites under `src/tools/` are defensive reader
  schemas for engine replies/manifest fields: `text_set`'s fit-reply reader,
  `layout_apply`'s `LAYOUT_APPLY_RESULT_SCHEMA`, `template_inspect`'s `autoFit`
  probe). Unions and discriminated unions are assembled **from** strict objects:
  `text_set`'s create/edit union, `layer_ops`' 7-op `z.discriminatedUnion("op", …)`,
  `style_apply`'s 9-style union, `asset_place` / `image_generate`'s `target`.
- The same strictness re-checks **results**: `TOOL_RESULT_SCHEMA` is a union of two
  `z.strictObject`s (`TOOL_OK_SCHEMA`, `TOOL_ERR_SCHEMA`), and `defineTool` runs every
  return value through `isToolResult()` — a malformed or extra-fielded result is
  replaced with `internal_error` ("The tool returned a malformed result"), never
  forwarded to the model.
- The executor boundary is `parseToolArgs(tool, raw)`: schema failure →
  `invalid_args` envelope whose hint lists the **zod issue paths** (never the
  argument values — §6.1 forbids echoing argument content back).

## 2. Caps actually used (every `.min(`/`.max(` and named limit, by grep)

### 2.1 Kit ceilings (`src/kit.ts`, exported constants)

| Constant | Value | Rule |
| --- | --- | --- |
| `MAX_ARG_STRING_CHARS` | **2000** | §6.2 caps text slot values at 2000; no string argument may exceed it (`cappedString` hard-asserts this via `assertCap`) |
| `MAX_ARG_ARRAY_ITEMS` | **200** | `cappedArray` ceiling |
| `MAX_ARG_RECORD_ENTRIES` | **40** | §6.2 "too many slots" at > 40; `cappedRecord` ceiling |
| `MAX_SUMMARY_CHARS` | **2000** | the compact-reply budget (§6.1 small replies) |
| `MAX_WARNINGS` / `MAX_WARNING_CHARS` | **20 × 500** | warning count/length budget |
| `MAX_ERROR_MESSAGE_CHARS` / `MAX_HINT_CHARS` | **1000 / 500** | error envelope budgets |
| `MAX_PREVIEW_URL_CHARS` | **2048** | preview URL length budget |
| `MAX_TOOL_NAME_CHARS` / `MAX_TOOL_DESCRIPTION_CHARS` | **64 / 500** | registry metadata (name regex: `^[a-z][a-z0-9_]{1,63}$`, description 10–500 chars) |

Named-schema helpers: `cappedString(max, min?)` (≤ 2000), `cappedArray(max, el)`
(≤ 200), `cappedRecord(max, el)` (≤ 40, refined "too many entries"), `zTemplateRef`
(`id@version`, 3–80 chars, regex-pinned), `zIdempotencyKey` (8–128, url-safe),
`zColor` (≤ 32 chars + format check), `zLayerRef` (id/name strings capped at 200).

### 2.2 Per-tool caps in force today

| Tool | Cap (value) | Where / why |
| --- | --- | --- |
| `workspace_snapshot` | 60 layers, 8 templates (×3 tags), 12 palette tokens, 8 fonts, 20 variable defs, 10 data sets, 10 comps, 5 recent runs; summary budget = 2000 | `MAX_LAYERS_IN_SNAPSHOT` … `MAX_RECENT_RUNS`; shed order + binary-search prefix truncation, every loss warns |
| `template_list` | tags ≤ 12 × 64 chars, query ≤ 120, ≤ 16 cards, ≤ 8 pins in hints | `MAX_LIST_TAGS`, `MAX_TAG_CHARS`, `MAX_QUERY_CHARS`, `MAX_LIST_CARDS`, `MAX_SHOWN_PINS` |
| `template_inspect` | ≤ 64 slots, thumbnail ≤ 80 chars, layerMap ≤ 128 entries; per-field probe caps (role/mask ≤ 64, component ≤ 129, description ≤ 4096, palette ≤ 8/channel triple, canvas 1–100 000) | `MAX_MANIFEST_SLOTS`, `MAX_THUMBNAIL_CHARS`, `MAX_LAYERMAP_ENTRIES`; §7.2 manifest probes |
| `template_apply` | pin regex `^[a-z0-9][a-z0-9-]{0,63}@[1-9][0-9]{0,9}$`, group name ≤ 120 non-blank | stricter than `zTemplateRef` on purpose (§6.1 reject at the boundary, not a BadParams round-trip) |
| `template_fill` | slots ≤ 40 (`MAX_ARG_RECORD_ENTRIES`), text value ≤ 2000, font ≤ 200, size 4–1200, focal 0–1 | §6.2 slot-value union, verbatim |
| `asset_search` | query ≤ 120, limit 1–120 (default 20), row names ≤ 40, no URLs/paths in rows | `MAX_QUERY_CHARS`, `MAX_RESULTS`, `DEFAULT_RESULTS`, `MAX_NAME_CHARS` |
| `asset_place` | canvas px ≤ 300 000 (`MAX_CANVAS_PX`), slot ≤ 120, focal 0–1, bounds `[x,y,w,h]` finite & in-canvas; upscale warn > 125%, hard stop > 200% (`UPSCALE_WARN_FACTOR` 1.25 / `UPSCALE_ERR_FACTOR` 2) | §7.3 upscale policy checked **before** any mutation |
| `image_generate` | prompt ≤ 1500 (sanitized), size enum {1024×1024, 1792×1024, 1024×1792}, PNG ≤ 5 MiB (`ENGINE_PNG_MAX_BYTES`, @studio/config) + magic/IHDR/dimension validation, sink path ≤ 1024 chars + no `..`/`\`/`:`/control chars | §15.3 output safety; §3.2 capability-root path guard |
| `text_set` | text ≤ 2000 non-blank, font ≤ 100 (trimmed), size 4–1200 pt, name ≤ 80 (trimmed, single-line), bounds x/y ± 1e9, w/h 1–1 000 000; fit floor 12 pt (`MIN_FIT_PT`) | `MIN_REQUESTED_PT`, `MAX_REQUESTED_PT`, `MAX_COORD_PX`, `MAX_BOX_PX` |
| `layer_ops` | refs ≤ 50 per call (`cappedArray(50, zLayerRef)`), layer names ≤ 200, opacity 0–1 (fraction, not %), > 7 loose layers → "document needs grouping" warning | `LOOSE_LAYER_LIMIT` 7 (§10.1) |
| `style_apply` | targets ≤ 50 (`MAX_TARGET_LAYERS`), shadow offset ± 2000, blur 0–100, stroke width 0–50, angle 0–360, unit ratios 0–1; adjustment `params` ≤ 20 keys / ≤ 64 array items / ≤ 200-char strings / depth ≤ 3 | `MAX_ADJ_PARAM_*`; §6.1 bounded JSON passthrough |
| `layout_apply` | tree depth ≤ 32, nodes ≤ 256, children/node ≤ 200, gap ≤ 256 px, padding side ≤ 2048, columns 1–24, coordinates/dimensions ≤ 1 048 576, grow ≤ 1e6, safeArea ≤ 512 | `LAYOUT_MAX_*` (§9.5 engine frame limits) |
| `ask_user` **[in-flight]** | question ≤ 300 chars, 1–4 options × ≤ 120 chars, all non-blank | `MAX_QUESTION_CHARS`, `MAX_OPTION_CHARS`, `MIN_OPTIONS`, `MAX_OPTIONS` (§23.1 rule 10: one ask_user per run) |
| `vision_critique` **[in-flight]** | brief ≤ 4000, layerSummary ≤ 4000, validatorReport ≤ 2000, rubric output ≤ 5 issues (§23.3; parse-side bound 50), previewUrl ≤ 2048 and http(s) only | `MAX_BRIEF_CHARS`, `MAX_LAYER_SUMMARY_CHARS`, `MAX_VALIDATOR_REPORT_CHARS`, `MAX_CRITIC_ISSUES`, `MAX_PARSED_ISSUES` |
| `validate_document` **[in-flight]** | `documentId` uuid + optional `template` pin (strictObject); issue report rides the 2000-char summary | §11.1 check table; issue caps exported for tests |

## 3. The compact-reply rule — summary strings ≤ 2000 chars

The enforced constant is **`MAX_SUMMARY_CHARS = 2000`** (`src/kit.ts`), double-checked
at two layers:

1. `ok()` **throws** `ToolError("invalid_tool_result")` for an empty or > 2000-char
   summary, > 20 warnings, a warning > 500 chars, a negative/non-integer
   `documentRevision`, or an unsafe `previewUrl`.
2. `defineTool` re-validates the envelope against `TOOL_RESULT_SCHEMA` and swaps any
   failure for a generic `internal_error` result — the model never sees a bloated or
   malformed reply.

Tools budget *before* calling `ok()` so the envelope always fits:
`asset_search.compactAssetTable` pops rows (never fields) until the JSON fits;
`template_list` caps cards at 16 and pops until the fit loop succeeds (+ "showing K
of M" warning); `workspace_snapshot` walks a shed order (recentRuns → comps →
variables → fonts → palette → templates → layer-prefix truncation → hard clamp) with
a warning per loss and regex scrubbing of paths/data-URIs/base64; `template_fill` /
`template_apply` / `text_set` render compact JSON fact-sets inside the string
summary (fleet precedent: the envelope's `summary` is a string; JSON rides in it).

## 4. Layer references — resolution order and ambiguity errors

`zLayerRef` = union of `strictObject({ layerId })` | `strictObject({ layerName })`
(both `cappedString(200, 1)`) — **never both**. The kit owns the two §6.1 errors:

- `ambiguousLayerErr(name, candidates)` → `code: "ambiguous_layer"`, message
  `Layer name "X" matches N layers`, hint lists up to **10** candidates +
  `(+N more)`, `retryable: false`.
- `layerNotFoundErr(ref)` → `code: "layer_not_found"`, hint points at
  `workspace_snapshot` and echoes the (truncated) reference.

Every mutating tool resolves refs **against `ctx.engine.listLayers()` BEFORE
building commands** — an unknown or ambiguous name is an actionable error, never a
silent edit of the wrong layer:

- `layer_ops.resolveLayerRef`: layerId → exact layerName → engine-style
  case-insensitive fallback; a miss lists the document's layers (≤ 8 + count) in the
  hint; the same layer twice in an align/group list is `validation_failed`.
- `asset_place` / `image_generate` `resolveLayer`: layerId → exact name only;
  > 1 exact match → `ambiguous_layer` with `name (id)` candidates.
- Slot targets (`asset_place`, `image_generate`, `template_fill` consumers) resolve
  slot → layer through every catalog manifest's image-slot `layerMap`, dedupe by
  layer id: 0 survivors → `layer_not_found`/`unknown_slots` (known-slot hint),
  > 1 → `ambiguous_layer` with candidates.

## 5. Colour formats

`zColor` accepts exactly the §6.1 set — `#RGB`, `#RRGGBB`, `rgb()`, `rgba()`,
`hsl()`, `hsla()` — with **channel range checks** (rgb 0–255, hsl 0–360/0–100/0–100,
alpha 0–1), no css-var indirection (kit `isValidColor`). Narrowing to the engine's
contract happens per tool, with an actionable error instead of a cryptic
`BadParams`:

- `style_apply.normalizeColor`: any §6.1 form → `#rrggbb` lowercase;
  `rgba()/hsla()` alpha < 1 is not representable in a layer style →
  `droppedAlpha` **warning**, never a silent loss.
- `text_set`: rgb/hsl → engine hex, including rgba alpha → `#rrggbbaa`.
- `template_fill`: the engine (`template.fill`/fill.rs `color_passthrough`) accepts
  only `#RRGGBB`/`#RRGGBBAA`; a rgb()/hsl() colour that passed the schema is
  rejected at compile time with `invalid_slots` + a §7.4 hint.

## 6. `previewUrl` — http(s) or root-relative only

`ok()` enforces `isSafePreviewUrl`: the URL must start with `https://`, `http://` or
`/`, be ≤ 2048 chars, and contain **no backslashes and no `..`** — violations throw
`invalid_tool_result` (a tool bug, not a model error). No current tool *emits* a
`previewUrl`; the field is reserved for `render_preview` (§6 row 14, pending), whose
worker persists the PNG bytes from `EngineLike.render` and hands the model only the
resulting URL — raw bytes never ride the envelope.

The consuming side is already live: `vision_critique` **[in-flight]** takes the
render URL as an **input** under a stricter rule — `isHttpPreviewUrl` accepts
`http(s)://` **only** (root-relative, `ftp:`, `file:`, `data:`, `javascript:` all
rejected; no control characters; ≤ `MAX_PREVIEW_URL_CHARS`), because the worker must
fetch the render over HTTP before the critic sees it (§15.3).

## 7. Idempotency keys

Schema atom: `zIdempotencyKey` — 8–128 chars, `^[A-Za-z0-9][A-Za-z0-9_-]*$`
("opaque url-safe tokens"). Actual use across the 13 tools:

| Tool | Key field | Required? | Money-path role |
| --- | --- | --- | --- |
| `image_generate` | `idempotencyKey` | **required** | the §14.2 ledger reason embeds it: `image_generate:<quality>:<key>` → exactly-once settlement via `CreditSpender.spendCredits` |
| `asset_place` | `idempotency_key` (snake) | **required** | dedupes doc.place placement retries |
| `style_apply` / `layout_apply` | `idempotencyKey` | **required** | mutating batch dedupe |
| `template_fill` / `text_set` | `idempotencyKey` | optional | accepted for executor retry dedupe; engine coalesces internally |
| `template_apply`, `layer_ops` | — | absent | `template_apply` is a scaffold apply (single command); `layer_ops`' shape was task-pinned — the executor journals every transactional batch (§5.6) instead |
| read-only tools (`workspace_snapshot`, `template_list`, `template_inspect`, `asset_search`) | — | absent | nothing mutates, nothing to dedupe |

Known fleet divergence, flagged for W5-R: `asset_place` uses snake_case
`idempotency_key` while the majority + README use `idempotencyKey` (camel). One of
the two must be reconciled when the barrel/registry wiring lands.

## 8. The error envelope and the real code inventory

Envelope (types.ts `ToolErr`, enforced by `err()` + `TOOL_ERR_SCHEMA`):

```
{ ok: false, code, message, hint?, retryable? }
```

`err()` itself enforces the contract: an unknown code throws
`invalid_tool_result`; empty/oversized messages (1000) and hints (500) throw.
`toToolErr` at the `defineTool` boundary guarantees §6.1's no-leak rule —
`ToolError` passes through its own code, `AbortError` → `engine_timeout`
(retryable), **anything else** → `internal_error` with a generic message (no
stack, no paths, no vendor text). A pre-aborted signal returns
`engine_timeout` (not retryable) without ever invoking `run`.

### 8.1 Literal `err("code")` inventory (grep of `src/tools/*.ts`, `src/example/echo.ts`, `src/kit.ts`)

| Code | Used by (literal call sites) | §6.1 / §13.3 rationale |
| --- | --- | --- |
| `validation_failed` (16) | text_set ×6 (font not in workspace, §10.2 machine/role-name check, duplicate name, non-Type layer, no-op edit), layer_ops ×4 (§10.2 name rules, empty set_props, same layer twice), asset_place ×2, image_generate ×2 (empty prompt after sanitize, > 200% upscale), style_apply ×1, echo ×1 | §13.3: payload failed semantic validation beyond what zod can express; every call carries an actionable hint |
| `internal_error` (8) | layer_ops ×2 (unresolvable ref, batch command rolled back), image_generate ×2 (missing seams — thrown as ToolError, sink path outside scope), template_fill ×1 (image slot with no resolved path), asset_place ×1 (unreachable slot-resolution fallback), kit ×2 (`toToolErr` catch-all, `defineTool` malformed-result swap) | §13.3: unexpected; the kit's never-leak fallback — no stack, no paths, no vendor text |
| `invalid_slots` (6) | template_fill ×4 (kind mismatch, non-fillable kind, engine-hex narrowing ×2), asset_place ×1, image_generate ×1 | §13.3: slot values fail the template's slot schema (§7.3). The engine's > 200% upscale refusal maps here in `imageUpscaleLimitErr` — the dedicated `image_upscale_limit` code is not yet in the add-only catalog (one-line swap point, flagged by W5-D/W5-E) |
| `not_found` (5) | template_fill ×2 (unknown template ref, unknown asset), template_apply ×2 (catalog miss + engine unknown-template), asset_place ×1, template_inspect ×2 (via `UNKNOWN_TEMPLATE_CODE = "not_found"`; swaps when §13.3 adopts `unknown_template`) | §13.3: unknown id — candidates in the hint, never confirm existence to strangers |
| `layer_not_found` (5) | layer_ops ×2 (id miss, name miss — richer hints than the kit helper), asset_place / image_generate / text-set via kit `layerNotFoundErr` | §6.1 tool-surface code: a layer ref resolved to nothing; hint lists the document's layers |
| `budget_exceeded` (5) | template_fill, asset_place, image_generate, text_set, style_apply — each charges `ctx.budgets.charge({ commands: n })` **before** dispatching mutations | §13.3: tier budget exhausted → clean stop, partial charge (§5.2) |
| `invalid_args` (4) | kit `parseToolArgs` ×1 (the executor boundary), asset_place ×2, image_generate ×1 (empty sanitized prompt) | §13.3/tool-surface: raw arguments failed the schema; hint carries zod issue paths, never values |
| `unknown_slots` (3) | template_fill ×1 (the exact §6.2 message `unknown slots: …` + known-slots hint), asset_place ×1, image_generate ×1 | §13.3: plan references slot names the template does not define |
| `image_provider_error` (3) | image_generate ×3 (provider throw, non-PNG mime, invalid PNG) — all `retryable: true` + §14.2 refund hint | §13.3: image provider failed; the worker refunds, the tool never does |
| `ambiguous_layer` (4) | kit `ambiguousLayerErr` ×1 (used by asset_place / image_generate / text_set), layer_ops ×1 (inline with `id N` candidates), asset_place ×1 + image_generate ×1 (slot resolves to several layers, candidates named `name (id)`) | §6.1: a layer_name matched several layers; candidates listed |
| `engine_unavailable` (2) | template_apply ×1 ("engine build does not implement the template commands" + engine-patches hint), layout_apply ×1 (same façade detection) | §13.3: no engine session / missing command registry |
| `engine_timeout` (2) | kit ×2 (`toToolErr` AbortError mapping; pre-aborted signal) | §3.4 deadline — the worker owns the clock, the boundary maps the signal |
| `text_overflow` (1) | text_set ×1 — the §6.1 exemplar error: message with exact px, hint `shorten to N chars or reduce size to Xpt` | §13.3: text does not fit its bounds after `layout.fitText` |
| `cross_tenant_denied` (1) | asset_place ×1 (asset org ≠ workspace org) | §15: never reach across the workspace boundary |
| `provider_unhealthy` (1) **[in-flight]** | vision_critique ×1 — the critic seam threw; the provider's own message never leaks (§13.3 has no transport code for the critic model, so §5.3's model-provider failure code applies), `retryable: true` | §5.3: model provider failure code |

In-flight additions to the inventory (same grep, working tree):
`validate_document` ×3 (`validation_failed` — document-generic rule refusals,
`not_found` — template pin missing from the catalog, `internal_error` — defensive
fallbacks) and `vision_critique` ×1 `invalid_args` (brief/layer summary empty after
§15.3 sanitization). `ask_user` emits **no** `err()` — a malformed question is an
`invalid_args` from `parseToolArgs` at the boundary; the tool itself only pauses
the run.

### 8.2 Dynamic code pass-through (seam failures keep their catalog code)

Tools hand engine/credit/sink failures through with their code **after validating it
against the catalog** — unmapped façade codes degrade, never throw:

- `workspace_snapshot.inspectFailure`: `err(failure.code, …)` with
  `retryableFor()` — engine-declared retryable wins, else the retryable set
  {`engine_timeout`, `engine_unavailable`, `engine_crashed`, `rate_limited`,
  `provider_unhealthy`}.
- `template_apply` / `layout_apply`: façade-code maps (`FACADE_CODE_FALLBACK` /
  `FACADE_TO_CATALOG`: `engine_command_failed`→`internal_error`,
  `reply_timeout`/`call_aborted`→`engine_timeout`,
  `auth_rejected`→`unauthorized`, `session_limit_reached`→`engine_unavailable`,
  `path_outside_capability_root`→`forbidden`, `plan_ceiling_exceeded`→`plan_limit`,
  `connection_dropped_mid_call`→`engine_crashed`, `frame_too_large`→`internal_error`);
  unknown codes → `internal_error`. This is where `unauthorized`, `forbidden`,
  `plan_limit`, `engine_crashed` first become reachable tool codes.
- `layer_ops.engineFailureErr`: `TOOL_ERROR_CODE_SCHEMA.safeParse(failure.code)` or
  fall back to `engine_unavailable`.
- `template_fill` / `asset_place` / `text_set` / `style_apply` / `image_generate`:
  `err(x.code, x.message, { hint, retryable })` passthroughs for engine batches,
  `CreditSpender` (`insufficient_credits`, `quota_exceeded`, …), and the
  generated-image sink — the seam already sanitizes per §13.3.

### 8.3 Kit/registry-only codes (never a tool-body literal)

`invalid_tool_result` (a tool misused `ok`/`err` — thrown, converted at the
boundary), `invalid_tool_name` (registry + `assertValidToolName`),
`duplicate_tool`, `unknown_tool` (registry — `get()` attaches the allowed list so
the planner corrects in one hop). §13.3 codes with no tool call site yet
(`storage_error`, `conflict`, `rate_limited`, `quota_exceeded`,
`insufficient_credits`, `unauthorized`, `forbidden`, `plan_limit`) surface only
via the dynamic paths above.

## 9. Seams inventory — every interface the worker must satisfy

`types.ts` keeps `ToolContext` **minimal and structural** on purpose: tools import
nothing from Wave 2/3 packages; the worker assembles a frozen context per call.

### 9.1 Base `ToolContext` seams (types.ts)

| Seam | Members | Consumed by | Conforming implementation (worker wiring) |
| --- | --- | --- | --- |
| `EngineLike` | `batch(cmds, { transaction, signal })`, `execute(cmd, { signal })`, `render(opts)`, `inspect()`, `listLayers()` | every engine-backed tool; `render` reserved for `render_preview` | Wave 2 `@studio/engine-client` (maps vendor codes → §13.3, logs unmapped originals server-side) |
| `DbLike` | `getDocument`, `appendCommandLog` | journaled by the agent runtime, rarely by tools | Wave 3 repositories (§5.6 WAL, tenant-scoped) |
| `TemplateCatalogLike` | `get(id@version)`, `list({ tag, limit })` | template_list, template_inspect, template_apply, template_fill, asset_place, image_generate (slot targets) | Wave 3/4 catalog repositories + gateway catalog (W4-J) |
| `AssetStoreLike` | `search(query, { limit })`, `get(assetId)` | asset_search, asset_place, image_generate, template_fill (asset_id → storageUrl) | Wave 3 repositories (§15.1 tenant-scoped) |
| `BudgetTracker` | `remaining()`, `charge({ commands, renderPx })` | every mutating tool before dispatch | worker run-slice meter (§5.2) |
| `WorkspaceContext` | `organizationId`, `brandTokens { palette, fonts }` | tenancy guards (asset_place cross-tenant check), font gate in text_set | worker per-call assembly |
| `ToolLogger` | `debug/info/warn/error(message, fields)` | all tools — breadcrumbs only, never tokens/paths | worker structured logger (§22) |

### 9.2 Tool-declared seams (beyond the base context)

| Seam | Declared in | Members | Worker wiring that satisfies it |
| --- | --- | --- | --- |
| `CreditSpender` (`ctx.credits`) | `image-generate.ts` | `spendCredits(amount, reason) → EngineOutcome<{ charged }>` | §14.2 ledger worker; reason embeds the idempotency key; worker refunds on failure — the tool never refunds |
| `ImageProviderLike` (`ctx.imageProvider`) | `image-generate.ts` | `generate(prompt, size, quality, signal) → { bytes, mime }` | §5.3 model router in the WORKER: drafts → Flux 2 Schnell, finals → Gemini 3 Pro Image; paid endpoints only (§1.5-6); the provider sees the prompt and nothing else (§15.3) |
| `GeneratedImageSinkLike` (`ctx.generatedImages`) | `image-generate.ts` | `put(bytes, fileName) → EngineOutcome<{ path }>` | worker persists bytes inside the workspace capability root (§3.2) and returns the engine-visible relative path for `doc.place` |
| `ImageGenerateContext` | `image-generate.ts` | `ToolContext + credits + imageProvider + generatedImages` | the worker's per-tool context assembly; `requireImageGenerateContext` throws `internal_error` when a seam is missing |

`image_generate` reads these three off `ctx` and **fails closed** (`internal_error`)
if the runtime forgot to wire them — the seam contract is enforced at run time, not
just at compile time. Same pattern, fresh from the working tree:

| Seam | Declared in | Members | Worker wiring that satisfies it |
| --- | --- | --- | --- |
| `CriticModelLike` (`ctx.critic`) **[in-flight]** | `vision-critique.ts` (W5-O) | `critique(input: CritiqueInput, signal) → CriticModelResult { raw, usage? }` — the seam THROWS on failure; the tool maps it to `provider_unhealthy` and never leaks the provider message | §5.3 "Critic (vision)" row in the WORKER: default Gemini 3.8 Flash (vision), premium Claude Sonnet 5.5, max Claude Opus 5.5; economy/quick tier routes null (critic skipped); paid endpoints only (§1.5-6); the §23.3 critic prompt ships VERBATIM as system prompt |
| `VisionCritiqueContext` **[in-flight]** | `vision-critique.ts` | `ToolContext + critic` | worker per-call assembly; `requireVisionCritiqueContext` fails closed |
| `ComponentRegistryLike` (`ctx.components`) **[in-flight]** | `component-set-vars.ts` (W5-L) | `listInstances(): ComponentInstanceRecord[]`, `getManifest(componentId): ComponentManifestLike \| undefined` — instance records + CURRENT manifest (mirrors set_vars_core's load_manifest) | worker wraps the engine's component library (engine-patches/component_cmds): tracks/queries per-document placements + §8.2 manifests |
| `ComponentSetVarsContext` **[in-flight]** | `component-set-vars.ts` | `ToolContext + components` | worker per-call assembly; `requireComponentSetVarsContext` fails closed |

`validate_document` **[in-flight]** adds **no** new seam: it runs on the base
`ToolContext` (`ctx.engine.inspect()`, `listLayers()`, `execute("template.validate")`
for the template arm, `ctx.templates.get/list`, `ctx.workspace.brandTokens.fonts`),
reading every extra inspect field defensively. `ask_user` **[in-flight]** touches
**no seam at all** — the pause/answer loop is the run manager's job, keyed off the
tool name.

### 9.3 Seams the still-pending tools will declare (expected, not yet in the tree)

The remaining §6 tools (see `tool-coverage.md`) follow the same local-seam pattern
(`registry-defaults.ts` explicitly defers to it — no `types.ts` augmentation until a
wave widens `ToolContext`):

- `render_preview` → a **PreviewSinkLike** (persist `EngineRenderReport.image`
  bytes, return the http(s) preview URL) + the existing `EngineLike.render`
  (≤ 1024 px longest edge, §6 row 14) and `BudgetTracker.renderPx`.
- `component_list` / `component_place` (W5-K, expected) → reuse the in-flight
  `ComponentRegistryLike` (`ctx.components`) + `component.list` / `component.place`
  engine commands.
- `export_document` → an **ExportJobLike** (enqueue §14 exports; `.pcraft`/PNG/JPG/
  PSD fidelity report) + `doc.save`/`doc.render`.
- `variant_create` → `layerComp.*`, `image.applyDataSet`, `image.variables.*` via
  the base `EngineLike` — likely no new seam.
- `brief_to_plan` → model-orchestrated (planner wave owns it); no engine seam.

## 10. The registry contract — `name + description` only in model context

`src/registry.ts`:

- **`TOOLS`** pins the §6 surface as a const object: **22 names** — 18 engine-backed
  rows plus the four model-orchestrated tools (`workspace_snapshot`,
  `brief_to_plan`, `vision_critique`, `ask_user`; §6 preamble). Registering under a
  name outside `Object.values(TOOLS)` is rejected
  (`invalid_tool_name`, "not part of the pinned tool surface").
- `register()`: snake_case + allowed-list + duplicate checks (`duplicate_tool`),
  and a shape check (Zod args schema, run function, description) → `internal_error`
  envelope. Typed envelopes, never throws.
- `get(name)`: miss → `unknown_tool` **with the full allowed list** in `hint.allowed`
  — the planner self-corrects in one hop.
- `list()` / `promptBlock()` expose **name + description only** — full argument
  schemas never enter prompts (§6.1). Descriptions are 10–500 chars (one useful
  sentence, feeds planner prompts verbatim).
- `echo` (`src/example/echo.ts`) is the annotated reference tool — *not* in `TOOLS`,
  never registered in production registries; it exists so Wave 5 authors copy the
  §6 shape (~40 lines: strict schema, `.default()`, ok/err, ctx + signal usage).
- **[in-flight]** `src/registry-defaults.ts` (W5-R) adds `buildDefaultToolRegistry()`:
  registers every shipped tool in §6 table order on a registry pinned to
  `Object.values(TOOLS)`, with fail-fast `ToolError` on a rejected registration.
  `echo` is included by default (dev/test contexts keep the §6.2 reference
  exercisable); production run managers pass `{ includeEcho: false }`.

### 10.1 Name pinning in the current tools

Seven tools register via `TOOLS.x` (`workspace_snapshot`, `template_apply`,
`image_generate`, `text_set`, `style_apply`, `layout_apply`, plus in-flight
`validate_document`); six use the literal string (`template_list`,
`template_inspect`, `template_fill`, `asset_search`, `asset_place`, `layer_ops`) —
both spellings are checked against the surface by `assertValidToolName` + the
registry's allowed list, so a typo cannot ship under an invented name.

## 11. Known gaps & flags (for the owning waves)

1. `src/index.ts` does not yet re-export `src/tools/*` — W5-R's in-flight
   `registry-defaults.ts` starts the assembly (`buildDefaultToolRegistry()`),
   and the barrel/`ToolMap` export lines still need to land with it.
2. `image_upscale_limit` (§7.3) and `unknown_template` are not yet in the §13.3
   add-only catalog; current stand-ins: `invalid_slots` (template_fill, one-line
   swap in `imageUpscaleLimitErr`) and `not_found` (template_inspect, swap in
   `UNKNOWN_TEMPLATE_CODE`).
3. `asset_place.idempotency_key` (snake) vs the fleet's `idempotencyKey` (camel).
4. `EngineCommandReport` lacks a payload field; tools read adapter-attached
   `result` payloads or `message`-JSON defensively (text_set fit metrics,
   template_fill report, template_apply reply, validate_document inspect rows).
   Adopting the seam-widening flagged in the W5 worklog removes the defensive
   readers.
5. The mock engine's `edit.transform` params ({ offset, factor }) drift from the
   vendor's relative form ({ scaleX%, scaleY%, dx, dy }) that asset_place /
   image_generate emit.
