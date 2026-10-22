/**
 * Client-side apply/undo engine — BUILD_PLAN §M5.4/§M5.5, DECISIONS.md D-6,
 * docs/phases/M5-SEAMS.md (`ApplyController`, pinned).
 *
 * ONE user gesture = ONE atomic `engine.batch` = ONE undo step = ONE version
 * (AGENTS.md hard rule 6). The whole flow NEVER throws — every outcome is a
 * typed union the plan card (M5-G) renders:
 *
 *  `apply(plan)`:
 *    1. resolve each `resolutionRequests` entry against the LIVE layer list
 *       (the executor's list_layers path: `comp.info {}` → `layers`) — a name
 *       matching exactly one layer binds it; ambiguous or unknown names fail
 *       BEFORE any engine mutation;
 *    2. patch the `compiledBatch` placeholders with the resolved layer ids
 *       (deterministic deep clone; null-prototype request map — the M4-N F-1
 *       lesson: model-adjacent keys never touch `Object.prototype`);
 *    3. `bridge.execute("engine.batch", batch)` — ONE call. Verified wire:
 *       the bridge passes the params object through `effectcraft.execute` →
 *       `engine.execute` → `batch.rs`, which reads `{steps, label?, atomic?}`
 *       (extra keys such as `timeoutMs` ride inert upstream — `timeoutMs` is
 *       §8.5 bound metadata the compiled batch carries, not an engine param);
 *    4. on success `await autosave.saveNow("agent-apply")` (D-6) — this
 *       uploads a NEW immutable version; the outcome's `version.id` is the
 *       applied versionId;
 *    5. `api.runs.applyRun(runId, {batchSha256, versionId, idempotencyKey})` —
 *       sha256 over the exact patched batch payload (WebCrypto via the
 *       editor-session sha256Hex, with its vector-tested sync fallback for
 *       hosts without `crypto.subtle` — never a new dependency), idempotency
 *       key generated ONCE per user gesture. Gateway errors map: 409 →
 *       conflict (explains, never re-applies), 402 → insufficient credits,
 *       else typed failure.
 *
 *  `undo(runId)`: `bridge.execute("edit.undo")` (the whole run folded into ONE
 *   undo step by `batch.rs`) THEN `api.runs.undoRun(runId, {idempotencyKey})`.
 *   If `edit.undo` fails ("nothing to undo" — the upstream `can_undo` guard,
 *   edit.rs:12) the gateway is NOT told — a typed `{ok:false}` comes back and
 *   the version rows are never touched (§9.3). The post-undo state is left to
 *   the D-6 cadence + the before-close save (undo is not a D-6 moment).
 *
 *  `reapply(plan)`: only when the client's CURRENT version id equals the plan's
 *   `baseVersionId` (the session port reads it); anything else is
 *   `{ok:false, reason:"base-version-changed"}` — BP §M5.5 "otherwise explain".
 *   NOTE for the integrator: after undo the session's current version is the
 *   APPLIED version's successor chain, so re-apply-after-undo needs the host
 *   page to restore the session's version pointer to the plan's base (a
 *   session-level concern — see the worklog M5-F record).
 *
 * Cross-agent pins (wave 1, reconciled by the integrator):
 *  - placeholder token: a whole-string `"$request:<requestId>"` in the compiled
 *    batch params, replaced with the resolved engine layer id (number);
 *  - `api.runs.applyRun/undoRun` — @studio/api-client names (M5-E adds them);
 *  - the plan event carries `compiledBatch` + `resolutionRequests` +
 *    `baseVersionId` (M5-C adds them to the wire; the SSE reader strips
 *    unknown keys until that lands, so the client treats them as optional).
 */

import type { SaveOutcome } from "@/lib/editor-session";
import { sha256Hex } from "@/lib/editor-session";
import type { AgentBatch, BatchStep } from "@studio/contracts";
import type { EditorBridge } from "@studio/editor-bridge";
import { isBridgeError, messageOf } from "@studio/editor-bridge";

// ---------------------------------------------------------------------------
// Pinned types (M5-SEAMS `ApplyController` + the runtime ports this engine needs)
// ---------------------------------------------------------------------------

/**
 * One layer the plan-compiler could not bind: args reference layers BY NAME;
 * the CLIENT resolves ids via the bridge (never ids into the model context,
 * PRODUCT_ARCHITECTURE §8.7). Shape pinned in M5-SEAMS (M5-B emits them).
 */
export interface LayerResolutionRequest {
  readonly requestId: string;
  readonly layerName: string;
  /** Hints the model gave for telling same-named layers apart (display-only). */
  readonly disambiguation: readonly string[];
}

/** Everything `apply` needs from a plan the client already rendered. */
export interface ApplicablePlan {
  /** The run that produced the plan (also the undo target). */
  readonly runId: string;
  /** The version the plan was compiled against — the reapply gate (§M5.5). */
  readonly baseVersionId?: string;
  /** The server-compiled `engine.batch` payload (allowlisted, §8.5-validated). */
  readonly compiledBatch: AgentBatch;
  /** Layer names to resolve + bind before execution (may be absent/empty). */
  readonly resolutionRequests?: readonly LayerResolutionRequest[];
}

/** Whole-string placeholder the plan-compiler leaves for a resolution request. */
export const RESOLVE_TOKEN_PREFIX = "$request:";

/** One bound request: the request id → the engine layer id it resolved to. */
export interface ResolvedLayer {
  readonly requestId: string;
  readonly layerId: number;
  readonly layerName: string;
}

export type ApplyOutcome =
  | { readonly ok: true; readonly versionId: string; readonly creditsCommitted?: number }
  | {
      /** A layer name matched more than one layer — nothing executed. */
      readonly ok: false;
      readonly reason: "ambiguous";
      readonly candidates: readonly string[];
      readonly message: string;
    }
  | {
      /** A layer name matched nothing — nothing executed. */
      readonly ok: false;
      readonly reason: "not-found";
      readonly layerName: string;
      readonly message: string;
    }
  | {
      /** A `$request:` placeholder could not be resolved/bound — nothing executed. */
      readonly ok: false;
      readonly reason: "resolution-failed";
      readonly message: string;
    }
  | {
      /** The compiled batch was malformed — nothing executed. */
      readonly ok: false;
      readonly reason: "invalid-batch";
      readonly message: string;
    }
  | {
      /** `engine.batch` rejected (atomic rollback upstream) — no save, no applyRun. */
      readonly ok: false;
      readonly reason: "engine-failed";
      readonly message: string;
    }
  | {
      /** The editor is not answering. */
      readonly ok: false;
      readonly reason: "editor-disconnected";
      readonly message: string;
    }
  | {
      /** The D-6 save failed to upload a version — the gateway was not told. */
      readonly ok: false;
      readonly reason: "save-failed";
      readonly message: string;
    }
  | {
      /** The D-6 save hit PROJECT_VERSION_CONFLICT (autosave parked) — reload to recover. */
      readonly ok: false;
      readonly reason: "save-conflict";
      readonly message: string;
    }
  | {
      /** Gateway 409 VERSION_CONFLICT — the run/version state moved; explains, never re-applies. */
      readonly ok: false;
      readonly reason: "conflict";
      readonly message: string;
    }
  | {
      /** Gateway 402 INSUFFICIENT_CREDITS — the batch + version landed; credits did not commit. */
      readonly ok: false;
      readonly reason: "insufficient-credits";
      readonly message: string;
    }
  | {
      /** Reapply gate: the client's current version is not the plan's base version. */
      readonly ok: false;
      readonly reason: "base-version-changed";
      readonly message: string;
    }
  | {
      /** Anything else (typed failure; `code` carries the §7.3 wire code when known). */
      readonly ok: false;
      readonly reason: "failed";
      readonly message: string;
      readonly code?: string;
    };

export type UndoOutcome =
  | { readonly ok: true; readonly undone: true }
  | { readonly ok: false; readonly reason: "nothing-to-undo"; readonly message: string }
  | { readonly ok: false; readonly reason: "engine-failed"; readonly message: string }
  | { readonly ok: false; readonly reason: "editor-disconnected"; readonly message: string }
  | {
      /** Gateway 409 — the run is not in an applied state (already undone?). */
      readonly ok: false;
      readonly reason: "conflict";
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly reason: "failed";
      readonly message: string;
      readonly code?: string;
    };

/** `apply`/`undo` milestones for the host page (banners, telemetry) — never throws. */
export type ApplyEngineEvent =
  | { readonly type: "apply.started"; readonly runId: string }
  | {
      readonly type: "apply.resolved";
      readonly runId: string;
      readonly resolved: readonly ResolvedLayer[];
    }
  | {
      readonly type: "apply.completed";
      readonly runId: string;
      readonly versionId: string;
      readonly creditsCommitted?: number;
    }
  | { readonly type: "apply.failed"; readonly runId: string; readonly outcome: ApplyOutcome }
  | { readonly type: "undo.started"; readonly runId: string }
  | { readonly type: "undo.completed"; readonly runId: string }
  | { readonly type: "undo.failed"; readonly runId: string; readonly outcome: UndoOutcome };

// ---------------------------------------------------------------------------
// Runtime ports (the EditorSessionClient/ChatControllerClient pattern — the
// real autosave controller, api-client (after M5-E) and host page satisfy them
// structurally; tests drive scripted fakes)
// ---------------------------------------------------------------------------

/** The slice of the M3-B autosave controller apply consumes (D-6). */
export interface ApplyAutosavePort {
  /** D-6 moments: `saveNow("agent-apply")` uploads the applied version. */
  saveNow(reason: string): Promise<SaveOutcome>;
  /** Belt-and-braces proactive dirty flag before the save (the M3-B lesson). */
  markDirty?(reason?: string): void;
}

/**
 * The slice of the editor session apply needs: the version id the session
 * currently sits on (the reapply gate, §M5.5). Implemented by the host page
 * over `manifest.currentVersion` + the autosave `onSaved` hook.
 */
export interface ApplySessionPort {
  currentVersionId(): string | null;
}

/** POST /v1/runs/:id/apply response (M5-SEAMS; M5-E owns the route). */
export interface ApplyRunResponse {
  readonly applied: true;
  readonly versionId: string;
  /** Plan credits committed by this apply (§8.8; 0 for replayed keys). */
  readonly creditsCommitted: number;
}

/** POST /v1/runs/:id/undo response. */
export interface UndoRunResponse {
  readonly undone: true;
}

/** The name→id resolutions posted with the apply (contracts RESOLVED_LAYER_SCHEMA). */
export interface PostedResolvedLayer {
  readonly requestId: string;
  readonly layerId: number;
}

/**
 * The apply surface of `@studio/api-client`'s `ApiClient` (M5-E landed
 * `runs.applyRun`/`runs.undoRun` — names pinned by the task + M5-SEAMS).
 */
export interface ApplyApiClient {
  readonly runs: {
    /** POST /v1/runs/:id/apply — body per contracts APPLY_REQUEST_SCHEMA. */
    applyRun(
      runId: string,
      body: {
        readonly batchSha256: string;
        readonly versionId: string;
        readonly idempotencyKey: string;
        readonly resolvedLayers?: readonly PostedResolvedLayer[];
      },
      options?: { readonly idempotencyKey?: string },
    ): Promise<ApplyRunResponse>;
    /** POST /v1/runs/:id/undo — body per contracts UNDO_REQUEST_SCHEMA. */
    undoRun(
      runId: string,
      body: { readonly idempotencyKey: string },
      options?: { readonly idempotencyKey?: string },
    ): Promise<UndoRunResponse>;
  };
}

export interface CreateApplyControllerOptions {
  /** The live editor bridge (ONE `engine.batch` per apply; `edit.undo` per undo). */
  readonly bridge: EditorBridge;
  /** The M3-B autosave controller (D-6: the apply moment is `saveNow("agent-apply")`). */
  readonly autosave: ApplyAutosavePort;
  /** The apply API surface (M5-E's api-client names). */
  readonly api: ApplyApiClient;
  /**
   * The version source for the reapply gate. When absent, `reapply` always
   * explains `base-version-changed` (conservative: an unverifiable gate never
   * re-executes anything).
   */
  readonly session?: ApplySessionPort;
  /** Milestone notifications for the host page — never throws, never retried. */
  readonly onEvent?: (event: ApplyEngineEvent) => void;
}

/** The pinned M5-SEAMS interface (apply/undo/reapply; redo stays engine-side). */
export interface ApplyController {
  apply(plan: ApplicablePlan): Promise<ApplyOutcome>;
  undo(runId: string): Promise<UndoOutcome>;
  reapply(plan: ApplicablePlan): Promise<ApplyOutcome>;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Bridge error codes that mean "the editor is not answering". */
const DISCONNECT_CODES: ReadonlySet<string> = new Set([
  "EDITOR_DISCONNECTED",
  "EDITOR_NOT_READY",
  "EDITOR_LOAD_FAILED",
  "EDITOR_TIMEOUT",
]);

/** The D-6 save reason for every agent apply (DECISIONS.md D-6, autosave.ts). */
const AGENT_APPLY_SAVE_REASON = "agent-apply";

/** Upstream `enabled`-guard why-string for an empty undo stack (edit.rs:12). */
const NOTHING_TO_UNDO_RE = /nothing to undo/i;

/** Bridge/editor failure → typed outcome; disconnect codes are named as such. */
function bridgeOutcome(error: unknown): {
  reason: "engine-failed" | "editor-disconnected";
  message: string;
} {
  const message = messageOf(error);
  if (isBridgeError(error) && DISCONNECT_CODES.has(error.code)) {
    return { reason: "editor-disconnected", message };
  }
  return { reason: "engine-failed", message };
}

/** The typed fields of an api-client throw (ApiError-shaped), without zod. */
function apiFailure(error: unknown): {
  status: number | null;
  code: string | undefined;
  message: string;
} {
  if (typeof error === "object" && error !== null && "status" in error) {
    const record = error as { status?: unknown; code?: unknown; message?: unknown };
    const status = typeof record.status === "number" ? record.status : null;
    const code = typeof record.code === "string" && record.code !== "" ? record.code : undefined;
    const message =
      typeof record.message === "string" && record.message !== "" ? record.message : "";
    return { status, code, message };
  }
  return { status: null, code: undefined, message: "" };
}

// ---------------------------------------------------------------------------
// Layer resolution (the executor's list_layers path — read-only)
// ---------------------------------------------------------------------------

interface CompLayerEntry {
  readonly id: number;
  readonly name: string;
}

/** `comp.info {}` → the active composition's layer list (query.rs; read-only). */
async function listLayers(bridge: EditorBridge): Promise<readonly CompLayerEntry[]> {
  const info = await bridge.query<{ layers?: unknown }>("comp.info", {});
  const raw = info?.layers;
  if (!Array.isArray(raw)) return [];
  const out: CompLayerEntry[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "number" || typeof record.name !== "string") continue;
    out.push({ id: record.id, name: record.name });
  }
  return out;
}

/**
 * Resolves every request against the live layer list. Read-only: the only
 * bridge traffic is ONE `comp.info` query however many requests there are.
 * Ambiguous/unknown names fail BEFORE anything executes.
 */
async function resolveRequests(
  requests: readonly LayerResolutionRequest[],
  bridge: EditorBridge,
): Promise<
  { ok: true; resolved: readonly ResolvedLayer[] } | { ok: false; outcome: ApplyOutcome }
> {
  let layers: readonly CompLayerEntry[];
  try {
    layers = await listLayers(bridge);
  } catch (error) {
    const failure = bridgeOutcome(error);
    const outcome: ApplyOutcome =
      failure.reason === "editor-disconnected"
        ? { ok: false, reason: "editor-disconnected", message: failure.message }
        : {
            ok: false,
            reason: "resolution-failed",
            message: "The layers could not be listed to resolve this plan. Try again in a moment.",
          };
    return { ok: false, outcome };
  }

  const resolved: ResolvedLayer[] = [];
  for (const request of requests) {
    // Exact-name matches only — a fuzzy match could bind the WRONG layer.
    const matches = layers.filter((layer) => layer.name === request.layerName);
    const first = matches[0];
    if (matches.length === 1 && first !== undefined) {
      resolved.push({ requestId: request.requestId, layerId: first.id, layerName: first.name });
      continue;
    }
    if (matches.length > 1) {
      return {
        ok: false,
        outcome: {
          ok: false,
          reason: "ambiguous",
          candidates: matches.map((layer) => `${layer.name} (layer ${layer.id})`),
          message: `Layer "${request.layerName}" matches ${matches.length} layers. Say which one you mean.`,
        },
      };
    }
    return {
      ok: false,
      outcome: {
        ok: false,
        reason: "not-found",
        layerName: request.layerName,
        message: `No layer named "${request.layerName}" is in the composition.`,
      },
    };
  }
  return { ok: true, resolved };
}

// ---------------------------------------------------------------------------
// Placeholder patch (deterministic deep clone; F-1-safe accumulators)
// ---------------------------------------------------------------------------

/**
 * Replaces every whole-string `"$request:<requestId>"` placeholder in the batch
 * params with the resolved layer id. Deterministic: only exact matches swap
 * and the clone preserves object key order, so the sha256 is stable.
 *
 * The cloned objects are NULL-PROTOTYPE (M4-N F-1): plan params are
 * model-adjacent — a parsed `{"__proto__": …}` key must ride as OWN data, not
 * rebind the clone's prototype.
 */
function patchPlaceholders(
  value: unknown,
  resolvedById: Readonly<Record<string, number>>,
): { patched: unknown; unresolved: string[] } {
  const unresolved: string[] = [];
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      if (!node.startsWith(RESOLVE_TOKEN_PREFIX)) return node;
      const requestId = node.slice(RESOLVE_TOKEN_PREFIX.length);
      const layerId = resolvedById[requestId];
      if (layerId === undefined) {
        unresolved.push(node);
        return node;
      }
      return layerId;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node === "object" && node !== null) {
      const out: Record<string, unknown> = Object.create(null);
      for (const [key, child] of Object.entries(node)) out[key] = walk(child);
      return out;
    }
    return node;
  };
  return { patched: walk(value), unresolved };
}

/** Narrow hand-rolled validation of the compiled batch (no zod in apps/web). */
function validCompiledBatch(batch: unknown): AgentBatch | null {
  if (typeof batch !== "object" || batch === null) return null;
  const record = batch as Record<string, unknown>;
  if (typeof record.label !== "string" || record.label.length === 0) return null;
  if (!Array.isArray(record.steps) || record.steps.length === 0) return null;
  const steps: BatchStep[] = [];
  for (const step of record.steps) {
    if (typeof step !== "object" || step === null) return null;
    const stepRecord = step as Record<string, unknown>;
    if (typeof stepRecord.command !== "string" || stepRecord.command.length === 0) return null;
    if (typeof stepRecord.params !== "object" || stepRecord.params === null) return null;
    steps.push({
      command: stepRecord.command,
      params: stepRecord.params as Record<string, unknown>,
    });
  }
  const timeoutMs =
    typeof record.timeoutMs === "number" &&
    Number.isInteger(record.timeoutMs) &&
    record.timeoutMs > 0
      ? record.timeoutMs
      : undefined;
  // Agent batches are ALWAYS atomic (§8.5) — forced regardless of the wire.
  return timeoutMs === undefined
    ? { label: record.label, atomic: true, steps }
    : { label: record.label, atomic: true, steps, timeoutMs };
}

// ---------------------------------------------------------------------------
// sha256 of the exact engine payload
// ---------------------------------------------------------------------------

/** The exact params object handed to `bridge.execute("engine.batch", …)`. */
export function engineBatchPayload(batch: AgentBatch): {
  label: string;
  atomic: true;
  steps: readonly BatchStep[];
  timeoutMs?: number;
} {
  return batch.timeoutMs === undefined
    ? { label: batch.label, atomic: true, steps: batch.steps }
    : { label: batch.label, atomic: true, steps: batch.steps, timeoutMs: batch.timeoutMs };
}

/**
 * sha256 over the serialized engine payload — the exact shape the editor
 * receives (JSON key order is deterministic: the payload object is built with
 * a fixed key order and the patched params preserve theirs).
 */
export async function batchSha256Hex(payload: unknown): Promise<string> {
  const serialized = JSON.stringify(payload) ?? "null";
  return sha256Hex(new TextEncoder().encode(serialized));
}

// ---------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------

export function createApplyController(options: CreateApplyControllerOptions): ApplyController {
  const { bridge, autosave, api } = options;

  const notify = (event: ApplyEngineEvent): void => {
    const callback = options.onEvent;
    if (callback === undefined) return;
    try {
      callback(event);
    } catch {
      /* a host callback must never break the apply engine */
    }
  };

  const failApply = (runId: string, outcome: ApplyOutcome): ApplyOutcome => {
    notify({ type: "apply.failed", runId, outcome });
    return outcome;
  };

  /** The shared execute-then-save-then-report path (apply + reapply). */
  const runApply = async (plan: ApplicablePlan): Promise<ApplyOutcome> => {
    // One gesture = one idempotency key (law #4), whatever happens below.
    const idempotencyKey = crypto.randomUUID();
    notify({ type: "apply.started", runId: plan.runId });

    const compiled = validCompiledBatch(plan.compiledBatch);
    if (compiled === null) {
      return failApply(plan.runId, {
        ok: false,
        reason: "invalid-batch",
        message: "The plan's compiled batch is malformed. Ask the agent to plan again.",
      });
    }

    // 1. Resolve layer names against the live list — read-only; on any
    //    ambiguity NOTHING executes (no engine.batch, no save, no applyRun).
    let resolvedById: Readonly<Record<string, number>> = {};
    let resolvedForWire: readonly PostedResolvedLayer[] = [];
    const requests = plan.resolutionRequests ?? [];
    if (requests.length > 0) {
      const resolution = await resolveRequests(requests, bridge);
      if (!resolution.ok) return failApply(plan.runId, resolution.outcome);
      notify({ type: "apply.resolved", runId: plan.runId, resolved: resolution.resolved });
      // Null-prototype accumulator (M4-N F-1): request ids are model-adjacent
      // strings — on a plain `{}` a `__proto__` id would hit the accessor.
      const map = Object.create(null) as Record<string, number>;
      for (const entry of resolution.resolved) map[entry.requestId] = entry.layerId;
      resolvedById = map;
      // §8.7/M5-E: the name→id bindings ride the applyRun body (auditable
      // server-side even though the batch already ran client-side).
      resolvedForWire = resolution.resolved.map((entry) => ({
        requestId: entry.requestId,
        layerId: entry.layerId,
      }));
    }

    // 2. Patch the placeholders with the resolved ids (deterministic clone).
    //    An unbound `$request:` token must never reach the engine as a string.
    const patchedSteps: BatchStep[] = [];
    const unresolved: string[] = [];
    for (const step of compiled.steps) {
      const patch = patchPlaceholders(step.params, resolvedById);
      unresolved.push(...patch.unresolved);
      patchedSteps.push({
        command: step.command,
        params: patch.patched as Record<string, unknown>,
      });
    }
    if (unresolved.length > 0) {
      return failApply(plan.runId, {
        ok: false,
        reason: "resolution-failed",
        message: `The plan still references unresolved layers (${unresolved.join(", ")}). Ask the agent to name the layer explicitly.`,
      });
    }

    const payload = engineBatchPayload({ ...compiled, steps: patchedSteps });
    const batchSha256 = await batchSha256Hex(payload);

    // 3. ONE engine.batch — law #6 (ONE call, atomic, one undo step).
    try {
      await bridge.execute("engine.batch", payload);
    } catch (error) {
      const failure = bridgeOutcome(error);
      return failApply(plan.runId, {
        ok: false,
        reason: failure.reason,
        message: failure.message,
      });
    }

    // 4. D-6: upload the applied state as a NEW version (awaited BEFORE the
    //    applyRun report so the gateway always sees a version that exists).
    autosave.markDirty?.(AGENT_APPLY_SAVE_REASON);
    const saved: SaveOutcome = await autosave.saveNow(AGENT_APPLY_SAVE_REASON);
    if (saved.saved !== true || saved.version === undefined) {
      return failApply(
        plan.runId,
        saved.conflict === true
          ? {
              ok: false,
              reason: "save-conflict",
              message:
                "The project changed elsewhere while the agent was working. Reload the latest version to continue — the edit is in the editor only.",
            }
          : {
              ok: false,
              reason: "save-failed",
              message:
                "The edit was applied but could not be saved as a version. It is in the editor only.",
            },
      );
    }
    const versionId = saved.version.id;

    // 5. Report to the gateway (ledger commit + run.applied, idempotent).
    try {
      const response = await api.runs.applyRun(plan.runId, {
        batchSha256,
        versionId,
        idempotencyKey,
        ...(resolvedForWire.length > 0 ? { resolvedLayers: resolvedForWire } : {}),
      });
      const outcome: ApplyOutcome = {
        ok: true,
        versionId: typeof response.versionId === "string" ? response.versionId : versionId,
        creditsCommitted: response.creditsCommitted,
      };
      notify({
        type: "apply.completed",
        runId: plan.runId,
        versionId: outcome.versionId,
        creditsCommitted: outcome.creditsCommitted,
      });
      return outcome;
    } catch (error) {
      const failure = apiFailure(error);
      if (failure.status === 409) {
        return failApply(plan.runId, {
          ok: false,
          reason: "conflict",
          message:
            "This plan was already applied or the run changed on the server. Nothing was re-executed.",
        });
      }
      if (failure.status === 402) {
        return failApply(plan.runId, {
          ok: false,
          reason: "insufficient-credits",
          message:
            "The edit and its version are saved, but there were not enough credits to commit this run.",
        });
      }
      return failApply(plan.runId, {
        ok: false,
        reason: "failed",
        message:
          failure.message !== ""
            ? failure.message
            : "The edit and its version are saved, but reporting it to the server failed.",
        code: failure.code,
      });
    }
  };

  return {
    apply: (plan: ApplicablePlan): Promise<ApplyOutcome> => runApply(plan),

    async undo(runId: string): Promise<UndoOutcome> {
      notify({ type: "undo.started", runId });
      // ONE edit.undo reverts the WHOLE run (batch.rs folds the steps).
      try {
        await bridge.execute("edit.undo");
      } catch (error) {
        const failure = bridgeOutcome(error);
        const outcome: UndoOutcome = NOTHING_TO_UNDO_RE.test(failure.message)
          ? { ok: false, reason: "nothing-to-undo", message: "There is nothing to undo." }
          : { ok: false, reason: failure.reason, message: failure.message };
        // The gateway is NOT told — undoRun would 409 on an unapplied run and
        // the version rows must stay untouched (§9.3).
        notify({ type: "undo.failed", runId, outcome });
        return outcome;
      }
      try {
        await api.runs.undoRun(runId, { idempotencyKey: crypto.randomUUID() });
        notify({ type: "undo.completed", runId });
        return { ok: true, undone: true };
      } catch (error) {
        const failure = apiFailure(error);
        const outcome: UndoOutcome =
          failure.status === 409
            ? {
                ok: false,
                reason: "conflict",
                message:
                  "The server says this run was not applied, so there is nothing to undo there.",
              }
            : {
                ok: false,
                reason: "failed",
                message:
                  failure.message !== ""
                    ? failure.message
                    : "The undo happened in the editor but could not be reported.",
                code: failure.code,
              };
        notify({ type: "undo.failed", runId, outcome });
        return outcome;
      }
    },

    async reapply(plan: ApplicablePlan): Promise<ApplyOutcome> {
      // §M5.5: only while the session still sits on the plan's base version.
      const current = options.session?.currentVersionId() ?? null;
      if (plan.baseVersionId === undefined || current === null || current !== plan.baseVersionId) {
        return failApply(plan.runId, {
          ok: false,
          reason: "base-version-changed",
          message:
            "The project changed since this plan was made, so re-applying it is not safe. Ask the agent to plan again.",
        });
      }
      return await runApply(plan);
    },
  };
}
