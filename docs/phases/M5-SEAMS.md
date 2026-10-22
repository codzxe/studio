# M5 — Pinned seams (fleet contract)

Status: **BINDING for all M5 agents** · 2026-10-23 · Owner: orchestrator.
Every brief quotes only its own slice; this file is the full map. Where a
brief and this file disagree, this file wins; where this file and the docs
(`BUILD_PLAN.md` §M5, `PRODUCT_ARCHITECTURE.md` §8.4–§8.8, `EDITOR_CHAT_UX.md`
§4–§7) disagree, the docs win — file a worklog note, never decide alone in code.

Scope (BUILD_PLAN §M5): the agent **changes the project safely, atomically and
reversibly**. Write tools propose batches; plans compile server-side; ONE
`engine.batch` = ONE undo step = ONE version; undo/redo; auto-apply off by
default. The editor UI stays frozen (law #7); everything remains an additive
overlay. Money follows D-12 (integer µc) + D-20 (settle releases the full hold).

## Architecture (M5 target flow)

```text
Model (LiteLLM/Mock runner) ── studio.plan_edit (structured, M4 flow) ──▶ EditPlan
Gateway plan-compiler (NEW, server-side): allowlist + $N refs + bounds +
  layer-name resolution REQUESTS → compiled AgentBatch + risk + credit estimate
  → {type:"plan", …} event now carries `compiledBatch` + `resolutionRequests`
Client plan card: risk/affected layers/credits/steps + preview + Apply/Cancel
  (high risk ⇒ explicit confirm checkbox §6.2)
Apply: bridge.execute("engine.batch", compiled) → result; autosave
  saveNow("agent-apply") creates the version; POST /v1/runs/:id/apply
  {batchSha256, versionId, …} → gateway: run.applied + ledger commit (idempotent)
Undo: bridge.execute("edit.undo") (ONE step for the whole run) + POST
  /v1/runs/:id/undo → run.undone; version rows are NEVER deleted (§9.3)
Re-apply: allowed only while base_version_id matches the client's current
  version; otherwise the card explains (BP M5.5)
```

- Write tools (8): `create_composition`, `create_text`, `set_properties`,
  `add_effect`, `set_keyframes`, `apply_preset`, `undo_run`, `save_version` —
  model-facing; results are PROPOSED batches (never direct execution).
- Curated command registry (NEW `@studio/contracts` `command-registry.ts`):
  the allowlist compiled from the REAL engine registry (558 `cmd!` ids in
  `editor/crates/engine/src/commands/*.rs`). Verified seed ids:
  `comp.new`, `layer.newText`, `layer.newSolid`, `layer.newNull`,
  `layer.newAdjustment`, `layer.rename`, `layer.arrange`, `layer.setBlendMode`,
  `text.insert`, `text.addSelector`, `prop.set`, `prop.addKey`,
  `prop.toggleAnimation`, `anim.addKeyframe`, `anim.applyPreset`,
  `anim.applyBuiltinPreset`, `effect.apply`, `effect.remove`, `effect.reorder`,
  `keys.move`, `keys.easyEase`, `edit.undo`, `edit.redo`, `comp.open`,
  `comp.close`, `comp.addMarker`. **Never** invent a command id; every id in
  the registry MUST be proven to exist in the Rust source (grep in a test or
  fixture snapshot). `engine.batch`/`command.list`/`command.describe` are
  transport/meta ids — not agent-batchable commands.
- The model never sees raw command ids (law #5): write tools take curated
  args (e.g. `{text, font?, size?}`), and the plan-compiler maps tool+args →
  registry command steps. Plan steps carry `tool` + `args`; the compiler
  validates/compiles the proposed `batch` fields against the registry.

## Pinned interfaces (all wave-1 agents code against THESE; integrator reconciles)

```ts
// packages/contracts/src/command-registry.ts (M5-J owns the file):
export const AGENT_COMMAND_REGISTRY: CommandSchema; // id → {id,title,params,undoable?}
export const AGENT_COMMAND_IDS: readonly string[];   // sorted allowlist
export function isAgentCommand(id: string): boolean;

// packages/contracts/src/write-tools.ts (M5-A owns the file):
export const WRITE_TOOL_IDS;                          // the 8 ids above
export const WRITE_TOOLS;                             // defs incl. zod args schemas
export const WRITE_TOOL_ARGS_SCHEMAS;                 // id → ZodObject (dunder-safe)

// services/gateway/src/plan-compiler.ts (M5-B owns the file):
export interface CompilePlanInput { plan: EditPlan; }   // + resolution context
export type CompilePlanResult =
  | { ok: true; batch: AgentBatch; risk: PlanRisk; estimatedCredits: number;
      resolutionRequests: LayerResolutionRequest[] }
  | { ok: false; issues: PlanIssue[] };                 // typed, never throws
// LayerResolutionRequest: {requestId, layerName, disambiguation: string[]}
//   — compiler emits when args reference layers BY NAME; the CLIENT resolves
//   ids via the bridge (list_layers) and posts them with the apply (never ids
//   into the model context; §8.7).

// packages/db (M5-D owns schema.ts + repos/runs.ts + repos/versions.ts):
// agent_runs gains: appliedAt, appliedBatchSha256, appliedVersionId,
//   baseVersionId, appliedAt undo fields: undoneAt, undoneBy
// repos.runs: recordApplied({workspaceId, runId, batchSha256, versionId, baseVersionId}),
//   recordUndone({workspaceId, runId, userId}), getPlanState(workspaceId, runId)
// repos.versions: createFromApply (existing create() reused — agentRunId column exists)

// services/gateway/src/routes/apply.ts (M5-E owns; mounted in index.ts):
POST /v1/runs/:id/apply   body {batchSha256, versionId, resolvedLayers?, idempotencyKey}
  → 200 {applied: true, versionId, creditsCommitted} | 409 VERSION_CONFLICT
     | 404 | 402 INSUFFICIENT_CREDITS (apply commits plan credits per §8.8)
POST /v1/runs/:id/undo    body {idempotencyKey} → 200 {undone: true} | 409 (not applied)
// Envelope + Zod at boundary; cross-tenant = 404; idempotency keys required (law #4).

// apps/web/src/lib/chat/apply.ts (M5-F owns the file):
export interface ApplyController { apply(plan): Promise<ApplyOutcome>;
  undo(runId): Promise<UndoOutcome>; redo/ reapply(plan): Promise<ApplyOutcome>; }
// created via createApplyController({bridge, session, client, onAutosave})
// executeBatch = bridge.execute("engine.batch", batch) — ONE call (law #6)
// after success: await autosave.saveNow("agent-apply") (D-6) THEN POST apply
```

## Ownership map (law #12 — you own ONLY your listed paths)

| Agent | Owns |
|---|---|
| M5-A | `packages/contracts/src/write-tools.ts` (NEW stub→full), `packages/contracts/src/tools.ts` (register write tools), colocated tests |
| M5-B | `services/gateway/src/plan-compiler.ts` (NEW), `services/gateway/tests/plan-compiler.test.ts` (NEW) |
| M5-C | `services/gateway/src/runner.ts`, `services/gateway/src/routes/chat.ts`, `services/gateway/src/routes/runs.ts` (write tools wired into the loop; plan event carries compiledBatch; agent_steps ONE-writer fix — M4 tail #2), colocated test edits in `services/gateway/tests/` **only inside files M4 already created for runner/chat** |
| M5-D | `packages/db/src/schema.ts` (M5 columns), `packages/db/drizzle/*` (generated), `packages/db/src/repos/{runs.ts,versions.ts,index.ts}`, `packages/db/tests/*` (integration) |
| M5-E | `services/gateway/src/routes/apply.ts` (NEW), `packages/contracts/src/routes/apply.ts` (NEW stub→full), `services/gateway/src/index.ts` (mount line ONLY — stub pre-added), `packages/api-client/src/{client.ts,response-schemas.ts}` (apply surface), `services/gateway/tests/apply.test.ts` (NEW) |
| M5-F | `apps/web/src/lib/chat/apply.ts` (NEW), `apps/web/src/lib/chat/tool-executor.ts` (write tool execution client-side), `apps/web/src/lib/chat/{chat-controller.ts,run-state.ts}` (apply/undo state hooks), colocated tests |
| M5-G | `apps/web/src/components/chat/{plan-card.tsx,confirm-dialog.tsx}` (NEW), colocated tests |
| M5-H | `apps/web/src/lib/chat/preview.ts` (NEW), `apps/web/src/components/chat/plan-preview.tsx` (NEW), colocated tests |
| M5-I | `apps/web/src/components/chat/{quick-actions.tsx,edit-cards.tsx}` (NEW), `apps/web/src/components/editor-host/**`, `apps/web/src/app/(app)/w/[slug]/editor/page.tsx`, colocated tests |
| M5-J | `packages/contracts/src/command-registry.ts` (NEW stub→full), `packages/contracts/tests/command-registry.test.ts` (NEW), `packages/contracts/src/index.ts` (**barrel line is pre-added — do NOT edit the barrel**) |

Shared files NOT owned by anyone in wave 1: `docs/DECISIONS.md` (orchestrator
only), `packages/contracts/src/index.ts` (pre-wired), the `pnpm-lock.yaml`
(no new deps without orchestrator approval), `.env*`.

## Coexistence rules (10 agents, one box)

- `scripts/git-sync.sh "M5-X: …"` when YOUR paths are complete; intermediate
  syncs encouraged. NEVER hand-roll git. The lock serializes you — expect waits.
- Gates (run once, at the END, for YOUR packages only; `--concurrency=1`):
  `pnpm --filter @studio/contracts typecheck && pnpm --filter @studio/contracts test`
  (gateway/db need `export DATABASE_URL=postgres://studio:studio@127.0.0.1:5432/studio`).
  This box OOMs on parallel tsc — do NOT run repo-wide turbo tasks.
- Append ONE worklog block at the end (heredoc, `cat >> worklog.md`). Read
  `tail -n 120 worklog.md` first. Report law-#12 findings in your worklog,
  never fix files you don't own.
- Biome: `pnpm exec biome check --write <your paths>` before your final sync.
- No new npm deps. No dev servers. No edits under `editor/` (frozen) or
  `archive/` (dead). `MOCK_MODEL=true` stays the test default (D-16).
