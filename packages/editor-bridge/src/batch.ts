/**
 * The `AgentBatch` contract for `EditorBridge.batch()` —
 * PRODUCT_ARCHITECTURE §6.2 / §8.5.
 *
 * UNIFIED with `@studio/contracts` (W1-b, packages/contracts/src/engine-batch.ts):
 * the canonical `AGENT_BATCH_SCHEMA` is the single source of truth for every
 * §8.5 bound (1..100 steps, atomic, ≤ 2 MB serialized, ≤ 60 s,
 * backwards-only `$N.key` references, label ≤ 280). This module only adds the
 * bridge-side input normalization: the editor bridge accepts a batch whose
 * `label` defaults to "Agent batch", `atomic` may be omitted (never `false`)
 * and step `params` may be omitted (`{}`), then validates it against the
 * canonical schema.
 *
 * The engine itself (editor/crates/engine/src/commands/batch.rs) also accepts
 * `atomic: false`; the *product* agent path must not use it (§8.5), and the
 * canonical schema rejects it. Code that genuinely needs a non-atomic engine
 * batch can still call `execute("engine.batch", …)` on the bridge directly.
 */

import {
  AGENT_BATCH_SCHEMA,
  type AgentBatch,
  BATCH_STEP_SCHEMA,
  type BatchStep,
  MAX_BATCH_BYTES,
  MAX_BATCH_STEPS,
  MAX_BATCH_TIMEOUT_MS,
} from "@studio/contracts";
import { z } from "zod";

export {
  AGENT_BATCH_SCHEMA as AgentBatchSchema,
  BATCH_STEP_SCHEMA as AgentBatchStepSchema,
  MAX_BATCH_STEPS,
  MAX_BATCH_TIMEOUT_MS,
  MAX_BATCH_BYTES as MAX_BATCH_PAYLOAD_BYTES,
  type AgentBatch,
  type BatchStep as AgentBatchStep,
};

/** The bridge-side input: label defaults, `atomic`/`params` optional. */
export const AgentBatchInputSchema = z.object({
  label: z
    .string()
    .nullish()
    .transform((v) => v ?? "Agent batch"),
  // Absent → atomic. An explicit `false` is rejected (agent batches are atomic, §8.5).
  atomic: z.literal(true).nullish(),
  steps: z
    .array(
      z.object({
        command: z.string().min(1),
        params: z
          .record(z.string(), z.unknown())
          .nullish()
          .transform((v) => v ?? {}),
      }),
    )
    .min(1)
    .max(MAX_BATCH_STEPS),
  /** Bridge-side call timeout for this batch (not forwarded upstream). */
  timeoutMs: z.number().int().positive().max(MAX_BATCH_TIMEOUT_MS).nullish(),
});

/** The bridge-side input type (pre-normalization): `z.input`, so callers may omit `label`/`atomic`/`params`. */
export type AgentBatchInput = z.input<typeof AgentBatchInputSchema>;

/**
 * Normalize a bridge input (defaults applied) and validate it against the
 * canonical `AGENT_BATCH_SCHEMA` (§8.5 bounds, `$N.key` references, 2 MB cap).
 * Throws a ZodError on any violation.
 */
export function normalizeAgentBatch(input: unknown): AgentBatch {
  const partial = AgentBatchInputSchema.parse(input);
  return AGENT_BATCH_SCHEMA.parse({
    label: partial.label,
    atomic: true,
    steps: partial.steps as BatchStep[],
    timeoutMs: partial.timeoutMs ?? undefined,
  });
}

/** Alias kept for readability at call sites. */
export const validateAgentBatch = normalizeAgentBatch;
