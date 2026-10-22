// @studio/contracts — the curated agent command registry (M5 seam, SEAMS §"command-registry").
//
// STUB — M5-J owns this file in Wave 1 and replaces this content with the
// full curated registry extracted from the REAL EffectCraft engine
// (`editor/crates/engine/src/commands/*.rs`, 558 `cmd!` ids). Every id MUST
// be proven to exist in the Rust source. Do not widen this surface without a
// DECISIONS.md ruling; the model never sees raw command ids (law #5).
import type { CommandSchema } from "./engine-batch.js";

/** Curated allowlist of agent-batchable engine commands (id → descriptor). */
export const AGENT_COMMAND_REGISTRY: CommandSchema = {};

/** Sorted ids of {@link AGENT_COMMAND_REGISTRY} (frozen snapshot). */
export const AGENT_COMMAND_IDS: readonly string[] = Object.freeze(
  Object.keys(AGENT_COMMAND_REGISTRY).sort(),
);

/** `true` when `id` is in the curated agent allowlist. */
export function isAgentCommand(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(AGENT_COMMAND_REGISTRY, id);
}
