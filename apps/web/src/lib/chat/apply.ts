/**
 * Client-side apply/undo engine — BUILD_PLAN §M5.4/§M5.5, DECISIONS.md D-6,
 * docs/phases/M5-SEAMS.md (`ApplyController`, pinned).
 *
 * ONE user gesture = ONE atomic `engine.batch` = ONE undo step = ONE version
 * (AGENTS.md hard rule 6). The whole flow NEVER throws — every outcome is a
 * typed union the plan card (M5-G) renders:
 *
 *  `apply(plan)`:
 *    0. ROUND-12 CLIENT-SPECIAL STEPS (pinned by the gateway plan compiler):
 *       the compiled batch may carry two convention ids the ENGINE batch
 *       cannot or must not run itself —
 *         * `script.run` — the engine refuses it inside `engine.batch`
 *           (NOT_IN_BATCH, batch.rs), so each script step executes via
 *           `bridge.execute("script.run", …)` BEFORE the batch, wrapped in
 *           ONE labeled undo group (`app.beginUndoGroup(label)`/`endUndoGroup`
 *           around the code, closed by a `finally` even when the script
 *           throws) so its edits are one undo entry; a FAILED script's
 *           partial edits are reverted (one label-verified `edit.undo`);
 *         * `asset.importSvg` — the local SVG import seam: the engine's
 *           string-based vector import command `edit.pasteSvg {svg, name?,
 *           comp?}` (allowed in the tier-2 catalog, journal:true, law-#5-clean
 *           — inline markup, never a filesystem path). An editor dist without
 *           it answers the typed `svg-import-unavailable` failure.
 *       BOTH run before layer resolution so steps can reference the layers
 *       they create BY NAME, and every later failure (resolution, batch)
 *       reverts what the pre-phase executed (best-effort, label-verified,
 *       bounded) — a failed gesture leaves NOTHING (§M5 exit criterion).
 *       ONE `saveNow` + ONE applyRun cover the whole gesture.
 *    1. validate the `compiledBatch` shape AND gate every step id:
 *       batch steps against ALLOWED_COMMAND_IDS (tier-2 ids-only list from
 *       `@studio/contracts` — a strict superset of the curated 37; the
 *       server compile already validated against the full catalog, this is
 *       defense in depth), the two client-special conventions against their
 *       pinned shapes (script code ≤ 20 000 chars, svg ≤ 50 000) — a
 *       non-member id is a typed `invalid-batch` BEFORE any engine traffic
 *       (the engine's registry + NOT_IN_BATCH rejections stay the
 *       defense-in-depth backstop);
 *    2. resolve each `resolutionRequests` entry against the LIVE layer list
 *       (the executor's list_layers path: `comp.info {}` → `layers`) — a name
 *       matching exactly one layer binds it; ambiguous or unknown names fail
 *       BEFORE any engine mutation;
 *    3. patch the `compiledBatch` placeholders with the resolved layer ids
 *       (deterministic deep clone; null-prototype request map — the M4-N F-1
 *       lesson: model-adjacent keys never touch `Object.prototype`);
 *    4. `bridge.execute("engine.batch", batch)` — ONE call. Verified wire:
 *       the bridge passes the params object through `effectcraft.execute` →
 *       `engine.execute` → `batch.rs`, which reads `{steps, label?, atomic?}`
 *       (extra keys such as `timeoutMs` ride inert upstream — `timeoutMs` is
 *       §8.5 bound metadata the compiled batch carries, not an engine param);
 *    5. on success `await autosave.saveNow("agent-apply")` (D-6) — this
 *       uploads a NEW immutable version; the outcome's `version.id` is the
 *       applied versionId;
 *    6. `api.runs.applyRun(runId, {batchSha256, versionId, idempotencyKey})` —
 *       sha256 over the exact patched batch payload (WebCrypto via the
 *       editor-session sha256Hex, with its vector-tested sync fallback for
 *       hosts without `crypto.subtle` — never a new dependency). Gateway
 *       errors map: 409 → conflict (explains, never re-applies) UNLESS the
 *       code is LEASE_HELD (M7/D-23 → the typed `lease-held` outcome, the
 *       server-side read-only guard is authoritative), 402 → insufficient
 *       credits, else typed failure. A LOCAL LEASE_HELD rejection from the
 *       M7 read-only gate (lib/editor-session read-only.ts) maps to the same
 *       `lease-held` outcome before anything reaches the engine.
 *
 *  Retention (law #4; F-L1/F-L2/F-L4 — the `toolresult:<runId>:<callId>`
 *  retention in tool-executor.ts is the precedent): once a run's batch has
 *  EXECUTED, the controller retains per run —
 *   * the gesture's idempotency key + the report pieces (batchSha256,
 *     resolvedLayers), so a RETRY of the same gesture reuses the key
 *     (a fresh gesture after a failure that never executed — or after a
 *     terminal outcome — mints a fresh key), and
 *   * the applied batch's label ("Agent: <summary>", from the compiledBatch),
 *     which `undo` compares against the engine's `{undone: label}` answer.
 *
 *  `retrySave(runId)` (F-L1): the re-save-only recovery for a run whose batch
 *   executed but whose version upload / gateway report did not land — steps
 *   5+6 ONLY; `engine.batch` is NEVER re-executed. The plan card's save-failed
 *   state wires "Retry save" to this; a typed `failed` answers when no
 *   applied-batch context is retained.
 *
 *  `undo(runId, hint?)`: `bridge.execute("edit.undo")` (the whole run folded
 *   into ONE undo step by `batch.rs`). The engine answers `{undone: label}`
 *   (edit.rs undo), which is compared against the run's batch label — the
 *   retained label, or `hint.batchLabel` when the thread layer passes the
 *   planRuntime's compiledBatch label for a controller that never saw the
 *   apply. An UNKNOWN or MISMATCHED pop is a typed
 *   `{ok:false, reason:"undo-stack-mismatch"}` and the gateway is NOT told
 *   (F-L4: the row never claims an undo that didn't happen; the popped
 *   batch sits on the redo stack and the outcome says so). Only a verified
 *   pop reaches `api.runs.undoRun(runId, {idempotencyKey})`. If `edit.undo`
 *   fails ("nothing to undo" — the upstream `can_undo` guard, edit.rs:12)
 *   the gateway is NOT told either (§9.3). The post-undo state is left to
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
import { isReadOnlyLeaseError, sha256Hex } from "@/lib/editor-session";
import type { AgentBatch, BatchStep } from "@studio/contracts";
import {
  ALLOWED_COMMAND_IDS,
  batchCreatedLayerNames,
  isAllowedEngineCommand,
} from "@studio/contracts";
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
      /** The D-6 save failed to upload a version — the gateway was not told.
       * F-L1: the batch DID execute; `batchApplied` says so and the retained
       * context backs a `retrySave` that never re-executes the batch. */
      readonly ok: false;
      readonly reason: "save-failed";
      readonly batchApplied?: true;
      readonly message: string;
    }
  | {
      /** The D-6 save hit PROJECT_VERSION_CONFLICT (autosave parked) — reload
       * to recover. F-L1: the batch DID execute; a parked conflict is
       * terminal for the session, so the recovery is the reload, not a retry. */
      readonly ok: false;
      readonly reason: "save-conflict";
      readonly batchApplied?: true;
      readonly message: string;
    }
  | {
      /** Gateway 409 VERSION_CONFLICT — the run/version state moved; explains, never re-applies. */
      readonly ok: false;
      readonly reason: "conflict";
      readonly message: string;
    }
  | {
      /** M7/D-23: another member holds the active edit lease. Either the
       * LOCAL read-only gate refused the batch before it could reach the
       * engine (nothing executed — the client gate is UX), or the gateway's
       * authoritative 409 LEASE_HELD refused the report after the save (the
       * batch + version DID land; the copy says which holder blocks and what
       * survived). Chat asking/proposing stays allowed — only apply is
       * gated. */
      readonly ok: false;
      readonly reason: "lease-held";
      readonly message: string;
      /** Present when the batch executed + saved and only the REPORT was
       * refused by the server-side lease guard. */
      readonly batchApplied?: true;
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
      /** The engine build has no string-based SVG import seam (the
       * `edit.pasteSvg` catalog id is unknown to the live editor) — nothing
       * executed beyond the steps the engine already reverted. */
      readonly ok: false;
      readonly reason: "svg-import-unavailable";
      readonly message: string;
    }
  | {
      /** Anything else (typed failure; `code` carries the §7.3 wire code when known). */
      readonly ok: false;
      readonly reason: "failed";
      readonly message: string;
      readonly code?: string;
    };

/** The failure arms of {@link ApplyOutcome} (the ok:false subset). */
export type ApplyFailure = Extract<ApplyOutcome, { ok: false }>;

export type UndoOutcome =
  | { readonly ok: true; readonly undone: true }
  | { readonly ok: false; readonly reason: "nothing-to-undo"; readonly message: string }
  | { readonly ok: false; readonly reason: "engine-failed"; readonly message: string }
  | { readonly ok: false; readonly reason: "editor-disconnected"; readonly message: string }
  | {
      /** F-L4 — the engine popped a batch that is not this run's (or one that
       * could not be verified): the pop is surfaced honestly (the popped edit
       * sits on the redo stack) and the gateway was NOT told — the row never
       * claims an undo that didn't happen. */
      readonly ok: false;
      readonly reason: "undo-stack-mismatch";
      readonly message: string;
    }
  | {
      /** Gateway 409 — the run is not in an applied state (already undone?). */
      readonly ok: false;
      readonly reason: "conflict";
      readonly message: string;
    }
  | {
      /** M7/D-23: another member holds the active edit lease — the local
       * gate refused `edit.undo` (nothing happened in the engine) or the
       * gateway's 409 LEASE_HELD refused undoRun (the gateway row was not
       * touched). */
      readonly ok: false;
      readonly reason: "lease-held";
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly reason: "failed";
      readonly message: string;
      readonly code?: string;
    };

/**
 * Optional `undo` hint (F-L4): the thread layer passes the plan's compiled-batch
 * label when the controller has no retained record (e.g. a fresh controller
 * over a session whose engine history still holds the applied batch).
 */
export interface UndoHint {
  readonly batchLabel?: string;
}

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
      /** The applied compiled batch — the host's post-apply canvas reveal
       * (comp.open + time.set + ui.playback) reads it. Absent on the F-L1
       * retrySave path (no batch re-executed there). */
      readonly batch?: AgentBatch;
    }
  | { readonly type: "apply.failed"; readonly runId: string; readonly outcome: ApplyOutcome }
  | { readonly type: "undo.started"; readonly runId: string }
  | { readonly type: "undo.completed"; readonly runId: string; readonly versionId?: string }
  | { readonly type: "undo.failed"; readonly runId: string; readonly outcome: UndoOutcome };

// ---------------------------------------------------------------------------
// Runtime ports (the EditorSessionClient/ChatControllerClient pattern — the
// real autosave controller, api-client (after M5-E) and host page satisfy them
// structurally; tests drive scripted fakes)
// ---------------------------------------------------------------------------

/** The slice of the M3-B autosave controller apply consumes (D-6). */
export interface ApplyAutosavePort {
  /**
   * D-6 moments: `saveNow("agent-apply")` uploads the applied version.
   * `options.agentRunId` tags the uploaded version row with the owning run —
   * the gateway's apply route ONLY settles a version whose `agentRunId`
   * equals the run (§9.3 scope guard); omitting it made EVERY apply answer
   * 404 VERSION_NOT_FOUND ("The edit didn't apply — nothing changed.").
   */
  saveNow(reason: string, options?: { readonly agentRunId?: string }): Promise<SaveOutcome>;
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
  /** F-L4: the optional `hint` carries the plan's compiled-batch label when
   * the caller holds it (the thread layer's planRuntime) — see UndoHint. */
  undo(runId: string, hint?: UndoHint): Promise<UndoOutcome>;
  reapply(plan: ApplicablePlan): Promise<ApplyOutcome>;
  /**
   * F-L1 — the re-save-only recovery: re-runs the D-6 save + the gateway
   * report for a run whose batch EXECUTED but whose version/report did not
   * land. NEVER re-executes `engine.batch`. A typed `failed` answers when
   * nothing is retained (the plan card's save-failed state wires this).
   */
  retrySave(runId: string): Promise<ApplyOutcome>;
  /**
   * w8 live-apply (optional — older engines answer undefined and the chat
   * controller degrades to the run-end apply): execute one turn's compiled
   * batch THE MOMENT the turn finishes, WITHOUT the gateway's run-keyed
   * applyRun report — the run is still streaming, so reporting now would
   * 409 (RUN_ALREADY_APPLIED) and waiting would show the user nothing until
   * the run ends. The batch still runs resolve→patch→engine.batch→saveNow
   * (one version per turn — the work persists), the undo ledger keeps every
   * turn's label (one Undo pops the whole run), and apply.completed fires so
   * the host reveals + plays the canvas (d820265 wiring).
   */
  applyLive?(plan: ApplicablePlan): Promise<ApplyOutcome>;
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
 * Layer names the plan's OWN batch creates before it references them.
 *
 * The plan compiler leaves a `$request:` placeholder for EVERY layer-name
 * site, and the client resolves those against the LIVE layer list before the
 * batch runs — but a plan that builds a scene from scratch (create comp →
 * create text → animate it) references layers that do not exist yet: on an
 * empty project `comp.info` fails outright, and mid-batch creations can
 * never resolve against a pre-batch snapshot. The engine accepts
 * id|name|#n layer refs and resolves names at each batch step's execution
 * time (commands run in order), so a name the batch itself creates can ride
 * through AS THE NAME: it binds deterministically to the step that just
 * made it. Anything else still resolves live (ambiguous/unknown = typed
 * failure before any engine traffic — unchanged safety default).
 *
 * 2026-11-01: the extraction moved to contracts (batchCreatedLayerNames) so
 * the gateway's turn-time validation and this deferral agree on ONE regex.
 */

/**
 * Resolves every request against the live layer list. Read-only: the only
 * bridge traffic is ONE `comp.info` query however many requests there are.
 * Ambiguous/unknown names fail BEFORE anything executes.
 */
async function resolveRequests(
  requests: readonly LayerResolutionRequest[],
  bridge: EditorBridge,
): Promise<
  { ok: true; resolved: readonly ResolvedLayer[] } | { ok: false; outcome: ApplyFailure }
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
  resolvedById: Readonly<Record<string, number | string>>,
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
// Round-12 client-special compiled steps (script.run / asset.importSvg)
// ---------------------------------------------------------------------------

/** Engine `NOT_IN_BATCH` id — executes via `bridge.execute`, never in-batch. */
const SCRIPT_RUN_COMMAND = "script.run";
/** The gateway plan-compiler's convention id for the inline SVG import step. */
const ASSET_IMPORT_SVG_COMMAND = "asset.importSvg";
/** The engine's string-based vector import command (tier-2-allowed, journal:true). */
const SVG_IMPORT_ENGINE_COMMAND = "edit.pasteSvg";

/** write-tools.ts MAX_SCRIPT_CODE_LENGTH mirror (the compiled provenance bound). */
const MAX_SCRIPT_STEP_CODE_CHARS = 20_000;
/** write-tools.ts MAX_SVG_LENGTH mirror. */
const MAX_SVG_STEP_CHARS = 50_000;

/** The engine's own "no such command" rejection (commands/mod.rs `find`). */
const UNKNOWN_COMMAND_RE = /unknown command/i;

/** One compiled step split by execution surface: pre-phase vs engine batch. */
interface PartitionedSteps {
  /** script.run + asset.importSvg steps, in compiled order. */
  readonly preSteps: readonly BatchStep[];
  /** Everything else — the atomic `engine.batch` payload. */
  readonly batchSteps: readonly BatchStep[];
}

function partitionCompiledSteps(steps: readonly BatchStep[]): PartitionedSteps {
  const preSteps: BatchStep[] = [];
  const batchSteps: BatchStep[] = [];
  for (const step of steps) {
    if (step.command === SCRIPT_RUN_COMMAND || step.command === ASSET_IMPORT_SVG_COMMAND) {
      preSteps.push(step);
    } else {
      batchSteps.push(step);
    }
  }
  return { preSteps, batchSteps };
}

/** Narrow shape check for one pre-phase step's params (compiled upstream). */
function preStepParamsError(step: BatchStep): string | null {
  const params = step.params as Record<string, unknown>;
  if (step.command === SCRIPT_RUN_COMMAND) {
    if (typeof params.code !== "string" || params.code.length === 0) {
      return `the script step's code is missing`;
    }
    if (params.code.length > MAX_SCRIPT_STEP_CODE_CHARS) {
      return "the script step's code is too long";
    }
    if (params.name !== undefined && typeof params.name !== "string") {
      return "the script step's name is not a string";
    }
    return null;
  }
  if (typeof params.svg !== "string" || params.svg.length === 0) {
    return "the SVG import step's svg markup is missing";
  }
  if (params.svg.length > MAX_SVG_STEP_CHARS) {
    return "the SVG import step's markup is too long";
  }
  for (const key of ["name", "comp"] as const) {
    if (params[key] !== undefined && typeof params[key] !== "string") {
      return `the SVG import step's ${key} is not a string`;
    }
  }
  return null;
}

/** Closest allowed id to a denied one (the repairable-error pattern). */
function closestAllowedHint(id: string): string {
  const dot = id.indexOf(".");
  const prefix = dot > 0 ? id.slice(0, dot + 1) : "";
  const near =
    prefix === ""
      ? []
      : ALLOWED_COMMAND_IDS.filter((allowed) => allowed.startsWith(prefix)).slice(0, 3);
  return near.length > 0 ? ` Closest allowed ids: ${near.join(", ")}.` : "";
}

/** Marks a script whose code ran but reported a script-level failure. */
class ScriptStepError extends Error {}

/** The engine's script.run failure shape: {ok:false, error:{message,line,column}}. */
function scriptFailureMessage(
  error:
    | { readonly message?: unknown; readonly line?: unknown; readonly column?: unknown }
    | null
    | undefined,
): string {
  const message =
    error !== null && typeof error === "object" && typeof error.message === "string"
      ? error.message
      : "the script reported an error";
  const line =
    error !== null && typeof error === "object" && typeof error.line === "number"
      ? ` at line ${error.line}`
      : "";
  return `The script failed: ${message}${line}. Nothing else from this plan ran.`;
}

/**
 * Wraps the model's script in ONE labeled undo group (the engine's documented
 * recipe: a script that throws KEEPS its prior edits, so scripts must wrap
 * themselves — the `finally` closes the group even on throw, which is what
 * makes a failed script's partial edits a single revertible entry).
 */
function wrapScriptInUndoGroup(label: string, code: string): string {
  return `app.beginUndoGroup(${JSON.stringify(label)});\ntry {\n${code}\n} finally {\n  app.endUndoGroup();\n}\n`;
}

/** What a pre-phase execution left on the undo stack (bottom → top order). */
interface PrePhaseLedger {
  /** The expected undo-entry label per executed step (`null` = unverifiable). */
  readonly labels: readonly (string | null)[];
  /** Whether the atomic `engine.batch` also ran (its folded entry is on top). */
  readonly batchRan: boolean;
}

/** Result of the best-effort pre-phase revert. */
interface RevertResult {
  readonly revertedAll: boolean;
  /** Honest continuation for the failure message when not everything reverted. */
  readonly note: string;
}

const REVERT_ALL: RevertResult = { revertedAll: true, note: "" };

/**
 * Pops the pre-phase entries that already executed — TOP FIRST, every pop
 * label-verified against the expected sequence (`null` expected = the entry's
 * label could not be known, accepted by count), stopping at the FIRST
 * foreign/unnamed pop or any undo failure: NEVER touch an edit that is not
 * this gesture's (F-L4 discipline). Never throws.
 */
async function revertPrePhaseEntries(
  bridge: EditorBridge,
  expectedBottomToTop: readonly (string | null)[],
): Promise<RevertResult> {
  for (let index = expectedBottomToTop.length - 1; index >= 0; index--) {
    const expected = expectedBottomToTop[index] ?? null;
    let popped: { undone?: unknown } | undefined;
    try {
      popped = await bridge.execute<{ undone?: unknown }>("edit.undo");
    } catch {
      return {
        revertedAll: false,
        note: " Some of the provisional edits this plan made could not be reverted automatically — undo them from the editor's History panel.",
      };
    }
    const poppedLabel =
      popped !== null && typeof popped === "object" && typeof popped.undone === "string"
        ? popped.undone
        : undefined;
    if (poppedLabel === undefined) {
      return {
        revertedAll: false,
        note: " The editor undid an unnamed edit while reverting this plan, so the remaining provisional edits were left in place — undo them from the editor's History panel.",
      };
    }
    if (expected !== null && poppedLabel !== expected) {
      return {
        revertedAll: false,
        note: " A different edit was on top of the undo stack while reverting this plan, so its remaining provisional edits were left in place — undo them from the editor's History panel.",
      };
    }
  }
  return REVERT_ALL;
}

/** The pasteSvg undo-entry label (via `command.describe`), or null when unverifiable. */
async function svgEntryLabel(bridge: EditorBridge): Promise<string | null> {
  try {
    const described = await bridge.query<{ label?: unknown }>("command.describe", {
      command: SVG_IMPORT_ENGINE_COMMAND,
    });
    return typeof described?.label === "string" && described.label.length > 0
      ? described.label
      : null;
  } catch {
    return null;
  }
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

/**
 * What the controller retains per run ONCE ITS BATCH EXECUTED (F-L1/F-L2;
 * the `toolresult:<runId>:<callId>` retention in tool-executor.ts is the
 * precedent): the apply gesture's idempotency key — a RETRY of the same
 * gesture reuses it; a fresh gesture after a failure that never executed, or
 * after a terminal outcome (applied / 409 / 402), mints a fresh key — plus
 * the pieces the save + report steps need. Cleared on every terminal outcome;
 * retained while a save or report is still owed.
 */
interface RunApplyRecord {
  readonly idempotencyKey: string;
  readonly batchSha256: string;
  readonly resolvedForWire: readonly PostedResolvedLayer[];
}

export function createApplyController(options: CreateApplyControllerOptions): ApplyController {
  const { bridge, autosave, api } = options;

  /** Retained per-run apply-gesture records (F-L1/F-L2). */
  const runRecords = new Map<string, RunApplyRecord>();
  /** Retained per-run applied-batch labels (F-L4) — they OUTLIVE a successful
   * apply (undo needs them) and are spent by a VERIFIED pop. */
  const appliedLabels = new Map<string, string>();
  /** Round-12: retained per-run pre-phase ledgers (script/SVG undo entries)
   * so `undo` can revert the WHOLE gesture, label-verified, not just the
   * folded batch entry. Cleared with the labels on a verified undo. */
  const prePhaseRecords = new Map<string, PrePhaseLedger>();
  /** w8 live-apply: runs whose turns were applied LIVE (per-turn, no gateway
   * applyRun report). Their undo pops every turn's label then skips the
   * gateway undoRun (the run was never reported applied — undoRun would 409
   * "run not applied"); a saveNow freezes the reverted state as a version. */
  const liveRuns = new Set<string>();

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

  /**
   * Steps 5+6 of the apply flow — shared by apply/reapply AND the F-L1
   * re-save-only retry (which starts here, never touching the engine):
   * upload the applied state as a NEW version (awaited BEFORE the applyRun
   * report so the gateway always sees a version that exists), then report.
   */
  const saveAndReport = async (
    runId: string,
    record: RunApplyRecord,
    context?: { readonly batch?: AgentBatch },
  ): Promise<ApplyOutcome> => {
    const saved: SaveOutcome = await autosave.saveNow(AGENT_APPLY_SAVE_REASON, {
      agentRunId: runId,
    });
    if (saved.saved !== true || saved.version === undefined) {
      // No version ⇒ the gateway is never told "applied". The divergence
      // (engine applied, version not) is surfaced honestly via
      // `batchApplied` + the copy, and the record STAYS so the card's
      // Retry save (retrySave) re-runs ONLY these steps (F-L1).
      return failApply(
        runId,
        saved.conflict === true
          ? {
              ok: false,
              reason: "save-conflict",
              batchApplied: true,
              message:
                "The project changed elsewhere while the agent was working. Reload the latest version to continue — the edit is in the editor only.",
            }
          : {
              ok: false,
              reason: "save-failed",
              batchApplied: true,
              message:
                "The edit was applied but could not be saved as a version. It is in the editor only.",
            },
      );
    }
    const versionId = saved.version.id;

    try {
      const response = await api.runs.applyRun(runId, {
        batchSha256: record.batchSha256,
        versionId,
        idempotencyKey: record.idempotencyKey,
        ...(record.resolvedForWire.length > 0 ? { resolvedLayers: record.resolvedForWire } : {}),
      });
      // Terminal success: the gesture reported — release the retained key.
      runRecords.delete(runId);
      const outcome: ApplyOutcome = {
        ok: true,
        versionId: typeof response.versionId === "string" ? response.versionId : versionId,
        creditsCommitted: response.creditsCommitted,
      };
      notify({
        type: "apply.completed",
        runId,
        versionId: outcome.versionId,
        creditsCommitted: outcome.creditsCommitted,
        ...(context?.batch !== undefined ? { batch: context.batch } : {}),
      });
      return outcome;
    } catch (error) {
      const failure = apiFailure(error);
      if (failure.status === 409 || failure.status === 402) {
        // Terminal server answers: release the retained key (a retry after
        // these is a NEW gesture — a retained key would make the idempotency
        // middleware replay the cached 409/402 answer forever).
        runRecords.delete(runId);
      }
      if (failure.status === 409) {
        // M7/D-23 (additive conflict arm): a 409 carrying the wire's
        // LEASE_HELD code is the server-side read-only guard refusing the
        // report — the server is AUTHORITATIVE, so surface it with its own
        // typed outcome and the gateway's copy (which names the holder).
        // The batch + version DID land; only the report is owed (the
        // idempotency middleware replays it once the lease is ours again).
        if (failure.code === "LEASE_HELD") {
          return failApply(runId, {
            ok: false,
            reason: "lease-held",
            batchApplied: true,
            message:
              failure.message !== ""
                ? `${failure.message} The edit and its version are saved, but the run could not be recorded — take the edit lease to finish reporting it.`
                : "Another member is editing this project right now. The edit and its version are saved, but the run could not be recorded — take the edit lease to finish reporting it.",
          });
        }
        return failApply(runId, {
          ok: false,
          reason: "conflict",
          message:
            "This plan was already applied or the run changed on the server. Nothing was re-executed.",
        });
      }
      if (failure.status === 402) {
        return failApply(runId, {
          ok: false,
          reason: "insufficient-credits",
          message:
            "The edit and its version are saved, but there were not enough credits to commit this run.",
        });
      }
      // Network/other failures keep the record: a retry of THIS gesture
      // reuses the key (F-L2) and the gateway's {batchSha256, versionId}
      // replay branch dedupes server-side.
      return failApply(runId, {
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

  /** The shared execute-then-save-then-report path (apply + reapply). */
  const runApply = async (plan: ApplicablePlan, live = false): Promise<ApplyOutcome> => {
    notify({ type: "apply.started", runId: plan.runId });

    const compiled = validCompiledBatch(plan.compiledBatch);
    if (compiled === null) {
      return failApply(plan.runId, {
        ok: false,
        reason: "invalid-batch",
        message: "The plan's compiled batch is malformed. Ask the agent to plan again.",
      });
    }

    // F-6 (round-12 widened) — the client gate, BEFORE anything reaches the
    // engine: every BATCH step id must be an ALLOWED engine command (the
    // tier-2 ids-only list from @studio/contracts — a strict superset of the
    // curated 37; the server compile already validated against the full
    // catalog, this is the client's defense in depth), and the two
    // client-special conventions must match their pinned shapes.
    const { preSteps, batchSteps } = partitionCompiledSteps(compiled.steps);
    const denied = batchSteps.find((step) => !isAllowedEngineCommand(step.command));
    if (denied !== undefined) {
      return failApply(plan.runId, {
        ok: false,
        reason: "invalid-batch",
        message: `The plan's compiled batch contains a command the agent may not run ("${denied.command}").${closestAllowedHint(denied.command)} Ask the agent to plan again.`,
      });
    }
    const malformed = preSteps.find((step) => preStepParamsError(step) !== null);
    if (malformed !== undefined) {
      return failApply(plan.runId, {
        ok: false,
        reason: "invalid-batch",
        message: `The plan's ${malformed.command} step is malformed (${preStepParamsError(malformed)}). Ask the agent to plan again.`,
      });
    }

    // One gesture = one idempotency key (law #4). F-L2: a retained record
    // means this is a RETRY of a gesture whose batch already executed — reuse
    // its key (the toolresult:<runId>:<callId> precedent). Fresh gestures
    // after pre-execution failures / terminal outcomes mint fresh keys.
    const retained = runRecords.get(plan.runId);
    const idempotencyKey = retained?.idempotencyKey ?? crypto.randomUUID();

    // 1. ROUND-12 PRE-PHASE — script.run + asset.importSvg steps, in compiled
    //    order, BEFORE resolution so later steps can reference the layers
    //    they create BY NAME. Every pre-phase undo entry is ledgered for the
    //    revert below + the gesture undo. $request: tokens are BATCH-step
    //    params only (the compiler never puts them in pre-phase params —
    //    scripts/SVG strings reference layers by name inside their own text).
    const preLabels: (string | null)[] = [];
    if (preSteps.length > 0) {
      const svgLabel = preSteps.some((step) => step.command === ASSET_IMPORT_SVG_COMMAND)
        ? await svgEntryLabel(bridge)
        : null;
      for (const step of preSteps) {
        const isScript = step.command === SCRIPT_RUN_COMMAND;
        const params = step.params as Record<string, unknown>;
        try {
          if (isScript) {
            const result = await bridge.execute<{
              ok?: unknown;
              error?: { message?: unknown; line?: unknown } | null;
            }>("script.run", {
              code: wrapScriptInUndoGroup(compiled.label, params.code as string),
              ...(typeof params.name === "string" ? { name: params.name } : {}),
            });
            if (result !== null && typeof result === "object" && result.ok === false) {
              // The wrapper's `finally` closed the group around the partial
              // edits — ledger it, then fail into the revert below.
              preLabels.push(compiled.label);
              throw new ScriptStepError(scriptFailureMessage(result.error));
            }
            preLabels.push(compiled.label);
          } else {
            await bridge.execute(SVG_IMPORT_ENGINE_COMMAND, {
              svg: params.svg,
              ...(typeof params.name === "string" ? { name: params.name } : {}),
              ...(typeof params.comp === "string" ? { comp: params.comp } : {}),
            });
            preLabels.push(svgLabel);
          }
        } catch (error) {
          // Revert what already executed so a failed gesture leaves NOTHING
          // (§M5), then map the failure honestly. When the FIRST pre-step is
          // the failure there is nothing to revert — no "reverted" claim.
          const revert = await revertPrePhaseEntries(bridge, preLabels);
          const suffix = revert.revertedAll
            ? preLabels.length > 0
              ? " The provisional edits this plan made were reverted."
              : ""
            : revert.note;
          if (isReadOnlyLeaseError(error)) {
            return failApply(plan.runId, {
              ok: false,
              reason: "lease-held",
              message: `${error.message} The plan was not applied — request edit access, or take the lease when it is free, then apply again.`,
            });
          }
          if (error instanceof ScriptStepError) {
            return failApply(plan.runId, {
              ok: false,
              reason: "engine-failed",
              message: `${(error as Error).message}${suffix}`,
            });
          }
          if (!isScript && UNKNOWN_COMMAND_RE.test(messageOf(error))) {
            return failApply(plan.runId, {
              ok: false,
              reason: "svg-import-unavailable",
              message: `This editor build cannot import SVG markup (SVG_IMPORT_UNAVAILABLE).${suffix}`,
            });
          }
          const failure = bridgeOutcome(error);
          return failApply(plan.runId, {
            ok: false,
            reason: failure.reason,
            message: `${failure.message}${suffix}`,
          });
        }
      }
    }

    // 2. Resolve layer names against the live list (read-only, but AFTER the
    //    pre-phase so its created layers resolve) — on any ambiguity the
    //    pre-phase entries are REVERTED (nothing survives the gesture).
    const failAfterPrePhase = async (outcome: ApplyFailure): Promise<ApplyOutcome> => {
      const revert = await revertPrePhaseEntries(bridge, preLabels);
      return failApply(
        plan.runId,
        revert.revertedAll ? outcome : { ...outcome, message: `${outcome.message}${revert.note}` },
      );
    };
    let resolvedById: Readonly<Record<string, number | string>> = {};
    let resolvedForWire: readonly PostedResolvedLayer[] = [];
    const allRequests = plan.resolutionRequests ?? [];
    // Names the batch itself creates ride through as NAME strings (engine
    // resolves them at each step's execution time — see
    // batchCreatedLayerNames); only the rest hit the live layer list.
    const createdNames = batchCreatedLayerNames(batchSteps);
    const requests = allRequests.filter((r) => !createdNames.has(r.layerName));
    const deferred = allRequests.filter((r) => createdNames.has(r.layerName));
    if (requests.length > 0) {
      const resolution = await resolveRequests(requests, bridge);
      if (!resolution.ok) return await failAfterPrePhase(resolution.outcome);
      notify({ type: "apply.resolved", runId: plan.runId, resolved: resolution.resolved });
      // Null-prototype accumulator (M4-N F-1): request ids are model-adjacent
      // strings — on a plain `{}` a `__proto__` id would hit the accessor.
      const map = Object.create(null) as Record<string, number | string>;
      for (const entry of resolution.resolved) map[entry.requestId] = entry.layerId;
      resolvedById = map;
      // §8.7/M5-E: the name→id bindings ride the applyRun body (auditable
      // server-side even though the batch already ran client-side).
      resolvedForWire = resolution.resolved.map((entry) => ({
        requestId: entry.requestId,
        layerId: entry.layerId,
      }));
    }
    // Batch-created names: bind the placeholder to the NAME ITSELF (string
    // value — the patcher passes non-number bindings through verbatim).
    if (deferred.length > 0) {
      const map = Object.create(null) as Record<string, number | string>;
      for (const [key, value] of Object.entries(resolvedById)) map[key] = value;
      for (const request of deferred) map[request.requestId] = request.layerName;
      resolvedById = map;
    }

    // 3. Patch the placeholders with the resolved ids (deterministic clone,
    //    batch steps only). An unbound `$request:` token must never reach the
    //    engine as a string.
    const patchedSteps: BatchStep[] = [];
    const unresolved: string[] = [];
    for (const step of batchSteps) {
      const patch = patchPlaceholders(step.params, resolvedById);
      unresolved.push(...patch.unresolved);
      patchedSteps.push({
        command: step.command,
        params: patch.patched as Record<string, unknown>,
      });
    }
    if (unresolved.length > 0) {
      return await failAfterPrePhase({
        ok: false,
        reason: "resolution-failed",
        message: `The plan still references unresolved layers (${unresolved.join(", ")}). Ask the agent to name the layer explicitly.`,
      });
    }

    const payload = engineBatchPayload({ ...compiled, steps: patchedSteps });
    const batchSha256 = await batchSha256Hex(payload);

    // 4. ONE engine.batch — law #6 (ONE call, atomic, one undo step). Skipped
    //    when the whole plan was pre-phase steps (there is no batch to run).
    const batchRan = batchSteps.length > 0;
    if (batchRan) {
      try {
        await bridge.execute("engine.batch", payload);
      } catch (error) {
        // M7/D-23 (additive): the LOCAL read-only gate (lib/editor-session
        // read-only.ts) rejects the batch with the typed LEASE_HELD outcome
        // BEFORE it reaches the engine — the pre-phase entries are still
        // reverted so the gesture leaves nothing.
        if (isReadOnlyLeaseError(error)) {
          return await failAfterPrePhase({
            ok: false,
            reason: "lease-held",
            message: `${error.message} The plan was not applied — request edit access, or take the lease when it is free, then apply again.`,
          });
        }
        const failure = bridgeOutcome(error);
        return await failAfterPrePhase({
          ok: false,
          reason: failure.reason,
          message: failure.message,
        });
      }
    }

    // The gesture executed: retain the key + report pieces for retries
    // (F-L1/F-L2), the label for the undo verification (F-L4), and the
    // pre-phase ledger so undo reverts the WHOLE gesture.
    // w8 live-apply: the run-keyed record is NOT retained (the gateway is
    // never told per-turn — reporting would 409 RUN_ALREADY_APPLIED while the
    // run is still streaming), but the undo ledger still accumulates every
    // turn's label: appliedLabels holds the LATEST turn's batch, and the
    // pre-phase ledger holds every EARLIER turn's — the existing multi-pop
    // undo loop reverts the whole run, top-first.
    let record: RunApplyRecord | undefined;
    const earlierLiveLabels: string[] = [];
    if (live) {
      const previous = prePhaseRecords.get(plan.runId);
      const previousLabel = appliedLabels.get(plan.runId);
      if (previous !== undefined && previousLabel !== undefined) {
        // Earlier live turns, newest-first, skipping unverifiable null labels.
        earlierLiveLabels.push(previousLabel, ...previous.labels.filter((l): l is string => l !== null));
      }
      liveRuns.add(plan.runId);
    } else {
      record = { idempotencyKey, batchSha256, resolvedForWire };
      runRecords.set(plan.runId, record);
    }
    appliedLabels.set(plan.runId, compiled.label);
    if (live || preLabels.length > 0) {
      prePhaseRecords.set(plan.runId, {
        labels: live ? [...earlierLiveLabels, ...preLabels] : [...preLabels],
        batchRan: live ? true : batchRan,
      });
    }

    // 5. D-6: upload the applied state as a NEW version, then report (the
    // shared steps 5+6 — also the whole of the F-L1 re-save-only retry).
    // The batch rides the completed event so the host can REVEAL the result
    // on the canvas (comp.open + time.set + playback) — the apply pipeline
    // repaints one still at a stale playhead, which reads as "nothing
    // happened" even though the engine state changed.
    autosave.markDirty?.(AGENT_APPLY_SAVE_REASON);
    // w8 live-apply: the version IS saved per turn (the work persists — no
    // rebuild), but the gateway's run-keyed applyRun report is SKIPPED (the
    // run is still streaming; it would 409 RUN_ALREADY_APPLIED).
    if (live) return await saveLive(plan.runId, { batch: compiled });
    if (record === undefined) {
      // Unreachable (the non-live branch always sets the record) — kept as a
      // typed guard instead of a non-null assertion.
      return failApply(plan.runId, {
        ok: false,
        reason: "failed",
        message: "The apply gesture lost its retry record — nothing was re-executed.",
      });
    }
    return await saveAndReport(plan.runId, record, { batch: compiled });
  };

  /**
   * w8 live-apply — the D-6 save WITHOUT the gateway report. Identical
   * outcome vocabulary to saveAndReport's save arms (the batch DID run, so
   * every failure is a save-failure with batchApplied: true); the success
   * notify still carries the batch so the host's reveal + playback wiring
   * (d820265) makes the canvas come alive the moment the turn lands.
   */
  const saveLive = async (
    runId: string,
    context?: { readonly batch?: AgentBatch },
  ): Promise<ApplyOutcome> => {
    const saved: SaveOutcome = await autosave.saveNow(AGENT_APPLY_SAVE_REASON, {
      agentRunId: runId,
    });
    if (saved.saved !== true || saved.version === undefined) {
      return failApply(
        runId,
        saved.conflict === true
          ? {
              ok: false,
              reason: "save-conflict",
              batchApplied: true,
              message:
                "The project changed elsewhere while the agent was working. Reload the latest version to continue — the edit is in the editor only.",
            }
          : {
              ok: false,
              reason: "save-failed",
              batchApplied: true,
              message:
                "The edit was applied but could not be saved as a version. It is in the editor only.",
            },
      );
    }
    const outcome: ApplyOutcome = { ok: true, versionId: saved.version.id };
    notify({
      type: "apply.completed",
      runId,
      versionId: saved.version.id,
      ...(context?.batch !== undefined ? { batch: context.batch } : {}),
    });
    return outcome;
  };

  /** The verified-pops → gateway-report tail shared by both undo paths. */
  const reportUndo = async (runId: string): Promise<UndoOutcome> => {
    try {
      await api.runs.undoRun(runId, { idempotencyKey: crypto.randomUUID() });
      notify({ type: "undo.completed", runId });
      return { ok: true, undone: true };
    } catch (error) {
      const failure = apiFailure(error);
      let outcome: UndoOutcome;
      if (failure.status === 409 && failure.code === "LEASE_HELD") {
        // M7/D-23 (additive conflict arm): the server-side lease guard
        // refused the undo report (someone else holds the lease). The undo
        // DID happen in the engine; the gateway row was not touched —
        // honest copy, no re-attempt while blocked.
        outcome = {
          ok: false,
          reason: "lease-held",
          message:
            failure.message !== ""
              ? `${failure.message} The undo happened in the editor, but the server could not record it — take the edit lease to finish reporting it.`
              : "Another member is editing this project right now. The undo happened in the editor, but the server could not record it — take the edit lease to finish reporting it.",
        };
      } else if (failure.status === 409) {
        outcome = {
          ok: false,
          reason: "conflict",
          message: "The server says this run was not applied, so there is nothing to undo there.",
        };
      } else {
        outcome = {
          ok: false,
          reason: "failed",
          message:
            failure.message !== ""
              ? failure.message
              : "The undo happened in the editor but could not be reported.",
          code: failure.code,
        };
      }
      notify({ type: "undo.failed", runId, outcome });
      return outcome;
    }
  };

  return {
    apply: (plan: ApplicablePlan): Promise<ApplyOutcome> => runApply(plan),

    /**
     * w8 live-apply — one turn's compiled batch, applied THE MOMENT the turn
     * finishes (the user watches the canvas build up live; every turn saves
     * its own version so nothing is ever rebuilt). Same execute path as
     * {@link runApply} with `live: true` — resolve→patch→engine.batch→
     * saveNow, NO gateway applyRun report (see the liveRuns doc).
     */
    applyLive: async (plan: ApplicablePlan): Promise<ApplyOutcome> => runApply(plan, true),

    /**
     * F-L1 — the RE-SAVE-ONLY recovery: the engine step is not in question
     * (the batch already executed), so `engine.batch` is NEVER re-run; only
     * the D-6 version upload + the gateway report retry, with the retained
     * gesture key and the original batchSha256/resolvedLayers.
     */
    retrySave: async (runId: string): Promise<ApplyOutcome> => {
      const record = runRecords.get(runId);
      if (record === undefined) {
        // Nothing executed-and-unsaved through THIS controller: an honest
        // typed refusal — never a silent re-execute of anything.
        return failApply(runId, {
          ok: false,
          reason: "failed",
          message:
            "This plan has no applied edit to re-save in this session. If the edit is still in the editor, save a version from the editor menu.",
        });
      }
      return await saveAndReport(runId, record);
    },

    async undo(runId: string, hint?: UndoHint): Promise<UndoOutcome> {
      notify({ type: "undo.started", runId });
      // The run's applied-batch label (F-L4): the retained label wins; the
      // optional hint (the thread layer passes the planRuntime's
      // compiledBatch label) covers a controller that never saw the apply.
      const expectedLabel = appliedLabels.get(runId) ?? hint?.batchLabel;

      // ROUND-12 — a gesture with pre-phase entries (script groups + SVG
      // imports) reverts as a SEQUENCE of label-verified pops: the folded
      // batch first (when it ran), then the pre-phase entries, top-first.
      // Every pop is verified (F-L4 discipline: never touch another edit);
      // a partial revert is surfaced honestly and the gateway is NOT told.
      const ledger = prePhaseRecords.get(runId);
      if (ledger !== undefined) {
        const pops: (string | null)[] = [];
        if (ledger.batchRan) pops.push(expectedLabel ?? null);
        pops.push(...[...ledger.labels].reverse());
        let poppedAny = false;
        for (const expected of pops) {
          let popped: { undone?: unknown } | undefined;
          try {
            popped = await bridge.execute<{ undone?: unknown }>("edit.undo");
          } catch (error) {
            if (isReadOnlyLeaseError(error)) {
              const outcome: UndoOutcome = {
                ok: false,
                reason: "lease-held",
                message: `${error.message} The undo was not performed — take the edit lease first.`,
              };
              notify({ type: "undo.failed", runId, outcome });
              return outcome;
            }
            const failure = bridgeOutcome(error);
            const outcome: UndoOutcome = NOTHING_TO_UNDO_RE.test(failure.message)
              ? { ok: false, reason: "nothing-to-undo", message: "There is nothing to undo." }
              : {
                  ok: false,
                  reason: failure.reason,
                  message: poppedAny
                    ? `${failure.message} Part of this run's edits were already undone in the editor, but the server was not told — redo restores them.`
                    : failure.message,
                };
            if (poppedAny) {
              appliedLabels.delete(runId);
              prePhaseRecords.delete(runId);
            }
            notify({ type: "undo.failed", runId, outcome });
            return outcome;
          }
          const poppedLabel =
            popped !== undefined && typeof popped.undone === "string" ? popped.undone : undefined;
          if (poppedLabel === undefined || (expected !== null && poppedLabel !== expected)) {
            if (poppedLabel !== undefined) {
              for (const [id, label] of appliedLabels) {
                if (label === poppedLabel) {
                  appliedLabels.delete(id);
                  runRecords.delete(id);
                }
              }
            }
            appliedLabels.delete(runId);
            prePhaseRecords.delete(runId);
            const outcome: UndoOutcome = {
              ok: false,
              reason: "undo-stack-mismatch",
              message:
                poppedLabel === undefined
                  ? "The editor undid an unnamed edit, so this run's undo could not be verified. The server was not told — redo restores it."
                  : "A different edit was on top of the undo stack, so this run was not marked undone. Undo that edit first, or redo to restore it.",
            };
            notify({ type: "undo.failed", runId, outcome });
            return outcome;
          }
          poppedAny = true;
        }
        // The whole gesture verified-popped: the retained state is spent.
        appliedLabels.delete(runId);
        prePhaseRecords.delete(runId);
        // w8 live-apply: the run was never reported applied (the per-turn
        // applies skipped the gateway report) — undoRun would 409 "run not
        // applied". Pop is verified; freeze the reverted state as a version
        // and fold the card locally.
        if (liveRuns.has(runId)) {
          liveRuns.delete(runId);
          const saved: SaveOutcome = await autosave.saveNow(AGENT_APPLY_SAVE_REASON, {
            agentRunId: runId,
          });
          notify({
            type: "undo.completed",
            runId,
            ...(saved.saved === true && saved.version !== undefined
              ? { versionId: saved.version.id }
              : {}),
          });
          return { ok: true, undone: true };
        }
        return await reportUndo(runId);
      }

      // ONE edit.undo reverts the WHOLE run (batch.rs folds the steps); the
      // engine answers {undone: label} (edit.rs undo).
      let popped: { undone?: unknown } | undefined;
      try {
        popped = await bridge.execute<{ undone?: unknown }>("edit.undo");
      } catch (error) {
        // M7/D-23 (additive): the LOCAL read-only gate refused the undo —
        // the engine was never touched and the gateway is not told.
        if (isReadOnlyLeaseError(error)) {
          const outcome: UndoOutcome = {
            ok: false,
            reason: "lease-held",
            message: `${error.message} The undo was not performed — take the edit lease first.`,
          };
          notify({ type: "undo.failed", runId, outcome });
          return outcome;
        }
        const failure = bridgeOutcome(error);
        const outcome: UndoOutcome = NOTHING_TO_UNDO_RE.test(failure.message)
          ? { ok: false, reason: "nothing-to-undo", message: "There is nothing to undo." }
          : { ok: false, reason: failure.reason, message: failure.message };
        // The gateway is NOT told — undoRun would 409 on an unapplied run and
        // the version rows must stay untouched (§9.3).
        notify({ type: "undo.failed", runId, outcome });
        return outcome;
      }
      const poppedLabel =
        popped !== undefined && typeof popped.undone === "string" ? popped.undone : undefined;
      // F-L4 — the stack-blind undo guard: verify the engine popped THE
      // RUN'S batch before telling the gateway. An unknown or mismatched pop
      // is surfaced honestly (the popped edit sits on the redo stack) and
      // the gateway row is never told an undo that didn't happen.
      if (poppedLabel === undefined || poppedLabel !== expectedLabel) {
        // The popped batch belongs to a different gesture: its run's retained
        // label + record (if any) are now stale — the applied state left the
        // stack through this run's undo.
        if (poppedLabel !== undefined) {
          for (const [id, label] of appliedLabels) {
            if (label === poppedLabel) {
              appliedLabels.delete(id);
              runRecords.delete(id);
            }
          }
        }
        const outcome: UndoOutcome = {
          ok: false,
          reason: "undo-stack-mismatch",
          message:
            poppedLabel === undefined
              ? "The editor undid an unnamed edit, so this run's undo could not be verified. The server was not told — redo restores it."
              : expectedLabel === undefined
                ? "This plan's edit could not be matched in this session's undo stack, so its undo was not reported. The server was not told — redo restores the edit the editor undid."
                : "A different edit was on top of the undo stack, so this run was not marked undone. Undo that edit first, or redo to restore it.",
        };
        notify({ type: "undo.failed", runId, outcome });
        return outcome;
      }
      // Verified: THE RUN'S batch popped — the retained label is spent.
      appliedLabels.delete(runId);
      return await reportUndo(runId);
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
