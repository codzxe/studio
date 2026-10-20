# @studio/tools

The semantic tool surface (spec §6). Tools wrap engine commands; **the model never
sees raw command ids**. Wave 5 authors add one file per tool here; this kit defines
the contract and enforces it.

## Tool contract (§6.1 — enforced by this kit, not by review)

| Rule | Enforcement |
| --- | --- |
| Argument schemas are strict: `additionalProperties: false` | `strictObject` (re-export of `z.strictObject`) |
| String length caps, array length caps, record caps | `cappedString(max, min?)` (≤ 2000), `cappedArray(max, el)`, `cappedRecord(max, el)` (≤ 40, §6.2) |
| Colours: `#RGB` / `#RRGGBB` / `rgb()` / `hsl()` | `zColor` (+ `isValidColor` predicate) |
| Layer refs accept `layer_id` **or** `layer_name`; ambiguity is an error with candidates | `zLayerRef`, `ambiguousLayerErr(name, candidates)`, `layerNotFoundErr(ref)` |
| Results mirror what the model needs next: `{ ok, summary, documentRevision?, warnings?, previewUrl? }` | `ok()` — summary ≤ 2000 chars, ≤ 20 warnings × ≤ 500, `previewUrl` http(s) or root-relative only |
| Errors are actionable: `{ code, message, hint, retryable? }` | `err()` — codes from the shared catalog (§13.3) + tool-surface codes in `types.ts` |
| Never expose tokens, internal/absolute paths, other tenants' ids | `ok`/`err`/`toToolErr` validate/sanitize; unknown throws never leak their message |
| Small replies — return a summary, not engine dumps | `TOOL_RESULT_SCHEMA` re-checks every result at the `defineTool` boundary; extras rejected |

Additional tool-wide rules from §6: a **5-second default timeout** (enforced by the
executor per §3.4 — the worker owns the clock) and an **idempotency key** on every
mutating tool's args — use `zIdempotencyKey` in the schema.

## Writing a tool (Wave 5)

```ts
// src/template_fill.ts — see src/example/echo.ts for the full annotated reference.
export const templateFill: Tool<TemplateFillArgs> = defineTool({
  name: TOOLS.template_fill,            // pinned to the §6 surface
  description: "Fill a template's slots. Text is fitted to the box; images placed and masked.",
  args: strictObject({
    template: zTemplateRef,
    idempotencyKey: zIdempotencyKey,
    slots: cappedRecord(40, z.union([/* text | image | color | visibility, §6.2 */])),
  }),
  async run(ctx, args, signal) {
    const manifest = await ctx.templates.get(args.template);
    if (manifest === undefined) return err("not_found", "Template is not applied to this document");
    const res = await ctx.engine.batch(compile(manifest, args.slots), { transaction: true, signal });
    if (!res.ok) return err(res.code, res.message, { hint: res.hint, retryable: res.retryable });
    return ok({ summary: "Filled 3 slots", documentRevision: res.value.revision });
  },
});
```

Notes:

- **`run` never throws** for expected failures — return `err(...)` or throw `ToolError`
  for typed failures. The `defineTool` boundary converts `AbortError` → `engine_timeout`
  and anything unknown → `internal_error` with a generic message (no leaks).
- Engine seam calls return **typed unions** (`EngineOutcome<T>`), not throws: branch on
  `res.ok` and convert failures with `err(res.code, …)`. This is the deliberate
  difference from the §6.2 sketch, which elides failure handling.
- `Tool.args` types its zod input as `unknown` because schemas may use `.default()`
  (§6.2 `fit`) — parsed input then differs from the inferred `TArgs`.
- Register tools with the runtime's `ToolRegistry` pinned to the §6 surface:

```ts
const registry = new ToolRegistry({ allowedNames: Object.values(TOOLS) });
registry.register(templateFill);          // { ok: true } | typed rejection envelope
const lookup = registry.get("template_fill");
if (lookup.ok) { /* lookup.tool: AnyTool */ } else { /* lookup.allowed — name list */ }
```

- Registry guarantees: duplicate names rejected (`duplicate_tool`), names outside
  `TOOLS` rejected (`invalid_tool_name`), `get` on an unknown name returns
  `unknown_tool` **with the allowed list**, and `list()`/`promptBlock()` expose
  `name + description` only — **never schemas in prompts**.

## Executor responsibilities (agent runtime)

1. `parseToolArgs(tool, rawArgs)` at the boundary → `invalid_args` envelope with
   issue paths in the hint (values are never echoed).
2. Enforce the §3.4 timeout via the `signal` passed to `run`.
3. Re-check budgets (`ctx.budgets`) around engine batches; stop cleanly when a
   boundary is crossed (§5.2).
4. Results are already schema-validated by `defineTool`; forward as-is.

## Layout

- `src/types.ts` — `Tool`, `ToolContext`, result envelopes, error-code catalog,
  and the **minimal structural seams** (`EngineLike`, `DbLike`,
  `TemplateCatalogLike`, `AssetStoreLike`, `BudgetTracker`). Wave 2's engine-client
  and Wave 3's repositories conform structurally; tools import nothing from them.
- `src/kit.ts` — `defineTool`, `ok`/`err`, schema helpers, `parseToolArgs`,
  `toToolErr`, `TOOL_RESULT_SCHEMA`.
- `src/registry.ts` — `ToolRegistry`, `TOOLS`, listing types.
- `src/example/echo.ts` — annotated reference implementation (not a product tool).
- `src/index.ts` — barrel + `ToolMap`.

Tests: `tests/kit.test.ts`, `tests/registry.test.ts` — pure logic, no engine, no db.
