/**
 * The M7 client-side read-only gate (BUILD_PLAN §M7 task 3; PRODUCT_ARCHITECTURE
 * §9.3/§11; DECISIONS.md D-23): when ANOTHER member holds the ACTIVE edit
 * lease, every MUTATING bridge call is rejected LOCALLY with a typed
 * `LEASE_HELD` outcome before it can ever reach the engine, while reads and
 * inspects pass untouched (§11: "Viewers can open the editor read-only").
 *
 * Scope (D-23, binding): the block covers PROJECT MUTATIONS only — chat
 * (asking, proposing, planning) stays fully ALLOWED for non-holders because
 * the agent may look and propose in read-only mode (ECUX §4.1); only APPLY
 * (and the other project writes) is gated. The read seams — `query`,
 * `inspect`, `commands`, `describe`, `renderFrame`, `screenshot`, `readFile`,
 * `addFile`/`addAsset` (the load surface a read-only open still needs) — all
 * pass through.
 *
 * Classification mirror (how the rest of the client already classifies
 * commands — this module must not invent its own rules):
 *   * `bridge.execute(command, …)` is the JOURNALED seam: every id that rides
 *     it is a `cmd!` registration (journal: true, engine commands/mod.rs) —
 *     an undoable MUTATION by definition, including `engine.batch` (the apply
 *     envelope, apply.ts step 3) and `edit.undo`/`edit.redo` (state changes
 *     too). The curated registry never lists read-only `query!` ids here.
 *   * `bridge.batch(…)` is `engine.batch` (law #6's atomic mutation envelope).
 *   * `bridge.request("engine.execute" | "engine.batch", …)` is the raw
 *     engine mutation transport — the same ids `tool-executor.ts` refuses as
 *     RAW_ENGINE_TOOL_IDS with zero bridge calls.
 *   * `saveToBrowser` mutates the stored project bytes — the autosave write
 *     path (suspended while read-only by the M3 controller; blocked here as
 *     defense-in-depth). (`removeStored` is not part of the EditorBridge
 *     interface — no product path reaches it through the bridge.)
 * The GATEWAY's `requireLeaseForMutation` (services/gateway/src/lease-guard.ts)
 * remains the AUTHORITATIVE enforcement (409 LEASE_HELD); this client gate is
 * UX so a non-holder's Apply never executes a batch that could not be saved.
 *
 * No React, no DOM, no network — pure session-layer TypeScript, like the rest
 * of lib/editor-session. `@studio/contracts` stays import-type-only from
 * apps/web, so the wire constant is mirrored (and pinned by type) below.
 */

import type * as Contracts from "@studio/contracts";
import type { EditorBridge } from "@studio/editor-bridge";

/**
 * Mirror of `LEASE_HELD_ERROR_CODE` (`@studio/contracts` routes/leases.ts) —
 * the same code the gateway's 409 answers carry, so ONE string identifies the
 * lease block on both sides of the wire. The `typeof` pin makes a contracts
 * value change a TYPECHECK failure here (the runtime import ban still holds).
 */
export const LEASE_HELD_ERROR_CODE: typeof Contracts.LEASE_HELD_ERROR_CODE = "LEASE_HELD";

/**
 * The typed LOCAL lease rejection. NOT a `BridgeError` (that union is the
 * bridge package's closed vocabulary for editor transport failures); this is
 * the session layer's own outcome, carried through `error.code` so the apply
 * engine (and tests) can branch without parsing messages.
 */
export class ReadOnlyLeaseError extends Error {
  readonly code: typeof LEASE_HELD_ERROR_CODE = LEASE_HELD_ERROR_CODE;
  /** Display name of the active holder (never a user id — law #1). */
  readonly holderName: string;

  constructor(holderName: string, message?: string) {
    super(message ?? `${holderName} is editing this project right now.`);
    this.name = "ReadOnlyLeaseError";
    this.holderName = holderName;
  }
}

/** `true` only for THIS module's rejections (never for transport errors). */
export function isReadOnlyLeaseError(value: unknown): value is ReadOnlyLeaseError {
  return value instanceof ReadOnlyLeaseError;
}

/**
 * The raw engine mutation transport ids, as a named mirror of the existing
 * client classifications (`tool-executor.ts`'s RAW_ENGINE_TOOL_IDS + apply's
 * `engine.batch` seam). Every id here is also refused as a
 * `request(method, …)` method while the gate is blocked.
 */
export const RAW_ENGINE_MUTATION_IDS: readonly string[] = Object.freeze([
  "engine.batch",
  "engine.execute",
  "edit.undo",
  "edit.redo",
]);

const RAW_ENGINE_MUTATION_METHODS: ReadonlySet<string> = new Set(RAW_ENGINE_MUTATION_IDS);

/**
 * The mutation classification the wrapper uses. `execute` is the journaled
 * seam, so EVERY command id riding it is a mutation (see the module doc) —
 * there is deliberately no per-command read list to drift against the engine
 * registry. Exported for tests + the worklog pin.
 */
export function isMutatingBridgeExecute(command: string): boolean {
  // All journaled commands mutate: an empty id can never be a real command,
  // and rejecting it matches the engine's own "unknown command" posture.
  return true;
}

/** `true` when `request(method, …)` rides the raw engine mutation transport. */
export function isMutatingBridgeRequestMethod(method: string): boolean {
  return RAW_ENGINE_MUTATION_METHODS.has(method);
}

// ---------------------------------------------------------------------------
// The gate (a live, mutable view the host keeps fed from the lease-state poll)
// ---------------------------------------------------------------------------

/** Call-time view of the read-only state (read by the bridge wrapper). */
export interface ReadOnlyGate {
  /** `true` while ANOTHER member holds the ACTIVE (unexpired) lease. */
  isBlocked(): boolean;
  /** The active holder's display name; `null` while unknown. */
  holderName(): string | null;
}

/** The writable side the host (and the lease banner) holds. */
export interface ReadOnlyGateHandle {
  readonly gate: ReadOnlyGate;
  /**
   * Land the latest lease verdict. `blocked` = another member holds the
   * ACTIVE lease (the caller already checked expiry); `holderName` is for the
   * typed rejection copy. Last write wins; polls may flip it live.
   */
  update(blocked: boolean, holderName: string | null): void;
}

export function createReadOnlyGate(
  initial: { readonly blocked?: boolean; readonly holderName?: string | null } = {},
): ReadOnlyGateHandle {
  let blocked = initial.blocked ?? false;
  let holderName = initial.holderName ?? null;
  return {
    gate: {
      isBlocked(): boolean {
        return blocked;
      },
      holderName(): string | null {
        return holderName;
      },
    },
    update(nextBlocked: boolean, nextHolderName: string | null): void {
      blocked = nextBlocked;
      holderName = nextHolderName;
    },
  };
}

// ---------------------------------------------------------------------------
// The wrapped bridge
// ---------------------------------------------------------------------------

function rejectBlocked(gate: ReadOnlyGate): never {
  throw new ReadOnlyLeaseError(gate.holderName() ?? "Someone");
}

/**
 * Wraps a bridge with the M7 read-only gate: while the gate says another
 * member holds the active lease, MUTATING calls reject locally with the typed
 * `LEASE_HELD` outcome and NEVER reach the engine; reads and inspects pass
 * through unchanged (D-23 — chat's read/proposal surface stays fully alive).
 *
 * The gate is read at CALL time, so one stable wrapper identity serves the
 * whole session and flips with the lease-state polls. The wrapper owns no
 * state and adds no listeners; `dispose()` forwards to the wrapped bridge.
 */
export function wrapReadOnlyBridge(bridge: EditorBridge, gate: ReadOnlyGate): EditorBridge {
  const guardMutation = (): void => {
    if (gate.isBlocked()) rejectBlocked(gate);
  };

  return {
    ready: () => bridge.ready(),
    inspect: () => bridge.inspect(),
    commands: (filter?: string) => bridge.commands(filter),
    describe: (command: string) => bridge.describe(command),
    // Reads pass — the agent may look and propose in read-only mode (D-23).
    query: <T = unknown>(command: string, params?: unknown) => bridge.query<T>(command, params),
    execute: async <T = unknown>(command: string, params?: unknown) => {
      // The journaled seam: every id here is a mutation (module doc). The
      // rejection arrives as a PROMISE rejection like every other bridge
      // failure (callers `await bridge.execute` inside try/catch).
      guardMutation();
      return await bridge.execute<T>(command, params);
    },
    request: async <T = unknown>(method: string, params?: unknown) => {
      // Only the raw engine mutation transport is blocked; control methods
      // (`ui.*`, `render.frame`, …) pass — the editor iframe itself stays
      // interactive in read-only mode (§9.3), and no product path drives
      // ui mutations through the bridge.
      if (isMutatingBridgeRequestMethod(method)) guardMutation();
      return await bridge.request<T>(method, params);
    },
    batch: async (batch: Parameters<EditorBridge["batch"]>[0]) => {
      // engine.batch — the apply envelope (law #6's atomic mutation).
      guardMutation();
      return await bridge.batch(batch);
    },
    renderFrame: (params: Parameters<EditorBridge["renderFrame"]>[0]) => bridge.renderFrame(params),
    addFile: (file: Blob | File | string, name?: string) => bridge.addFile(file, name),
    addAsset: (asset: Parameters<EditorBridge["addAsset"]>[0]) => bridge.addAsset(asset),
    saveToBrowser: async (path: string) => {
      // Writes the project bytes to the editor's storage (the autosave write
      // path) — a project mutation; blocked while another member edits.
      guardMutation();
      return await bridge.saveToBrowser(path);
    },
    readFile: (path: string) => bridge.readFile(path),
    screenshot: (params?: Parameters<EditorBridge["screenshot"]>[0]) => bridge.screenshot(params),
    on: (event: Parameters<EditorBridge["on"]>[0], cb: Parameters<EditorBridge["on"]>[1]) =>
      bridge.on(event, cb),
    version: () => bridge.version(),
    info: () => bridge.info(),
    capabilities: () => bridge.capabilities(),
    dispose: () => bridge.dispose(),
  };
}
