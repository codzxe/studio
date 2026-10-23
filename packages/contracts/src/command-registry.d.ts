import type { CommandSchema } from "./engine-batch.js";
/** Curated allowlist of agent-batchable engine commands (id → descriptor). */
export declare const AGENT_COMMAND_REGISTRY: CommandSchema;
/** Sorted ids of {@link AGENT_COMMAND_REGISTRY} (frozen snapshot). */
export declare const AGENT_COMMAND_IDS: readonly string[];
/** `true` when `id` is in the curated agent allowlist. */
export declare function isAgentCommand(id: string): boolean;
/**
 * Undoability heuristic — source-verified at the BATCH level, deliberately not
 * per command:
 *   * `edit.undo` / `edit.redo` are real engine registrations (edit.rs:862-863), so the
 *     engine Session has an undo history;
 *   * an atomic `engine.batch` folds every undo step its steps recorded into ONE step
 *     labeled with the batch label (batch.rs `fold`), which is law #6;
 *   * every curated id is a `cmd!` registration (journal: true, mod.rs:134).
 * Membership therefore means: "run inside an applied atomic agent batch, its effects
 * are covered by that batch's single undo step" — NOT "pushes its own undo step"
 * (that is a per-handler property and is not claimed here).
 */
export declare const AGENT_COMMAND_UNDOABLE: ReadonlySet<string>;
/**
 * Transport/meta ids the registry never lists as batchable commands: the batch
 * envelope itself (raw `CommandSpec` in batch.rs, explicitly rejected inside batches
 * by the engine's NOT_IN_BATCH list) and the live-registry introspection queries
 * (query.rs:210-211, `journal: false`). They exist in the engine but never in
 * AGENT_COMMAND_IDS.
 */
export declare const META_COMMAND_IDS: readonly string[];
