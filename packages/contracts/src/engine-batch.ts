// @studio/contracts — `engine.batch` wire contract (PRODUCT_ARCHITECTURE.md §8.5).
//
// Safety model (§8.5 "Properties that make this the safety model"):
//   * Atomic  — a failing step rolls the whole batch back.
//   * One undo step — the entire agent run is a single `edit.undo`.
//   * References — `$N.key` lets later steps use earlier step results.
//   * Validated — every command id/param is checked against the live registry
//     (`effectcraft.commands()` / `command.describe`) before execution.
//   * Bounded — max 100 steps, max 2 MB payload, 60 s timeout.
//
// `$N.key` convention (1-based, backwards only):
//   * Step results are addressed by position: `$1`, `$2`, …
//   * `$N.key` reads field `key` (dotted paths allowed: `$2.transform.position`)
//     from the result of step N. Only a *previous* step may be referenced —
//     `$N` where N >= the current step index is rejected.
//   * A bare `$N` with no `.key` is NOT treated as a reference: currency-like
//     strings in text params ("$100", "$1,000") must not break batches. Bare
//     whole-result references are not part of the v1 convention.
//   * Command ids/params in examples are illustrative; the live registry is
//     authoritative. Never hardcode a command id without a test that it exists.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Bounds (§8.5)
// ---------------------------------------------------------------------------

/** Hard cap on the number of steps in one batch (§8.5 "Bounded"). */
export const MAX_BATCH_STEPS = 100;

/** Hard cap on the serialized JSON length of one batch (2 MB, §8.5). */
export const MAX_BATCH_BYTES = 2 * 1024 * 1024;

/** Hard cap on batch execution time (60 s, §8.5). */
export const MAX_BATCH_TIMEOUT_MS = 60_000;

/** Applied when `timeoutMs` is omitted — always the documented ceiling. */
export const DEFAULT_BATCH_TIMEOUT_MS = MAX_BATCH_TIMEOUT_MS;

/** Suggested cap for the human-readable batch label (`"Agent: <summary>"`). */
export const MAX_BATCH_LABEL_LENGTH = 280;

// ---------------------------------------------------------------------------
// Step + batch schemas
// ---------------------------------------------------------------------------

/** One engine command invocation: `command` + `params` (§8.5). */
export const BATCH_STEP_SCHEMA = z.object({
  command: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
});

export type BatchStep = z.infer<typeof BATCH_STEP_SCHEMA>;

// ---------------------------------------------------------------------------
// `$N.key` references
// ---------------------------------------------------------------------------

/** One extracted `$N.key` reference from a batch payload. */
export interface BatchRef {
  /** Raw matched string, e.g. `"$2.layer"`. */
  readonly raw: string;
  /** 1-based step position being referenced. */
  readonly step: number;
  /** Dotted result path after the step index; at least one segment. */
  readonly path: readonly string[];
  /** Where the reference appeared (object path within the walked value). */
  readonly origin: string;
}

const REF_PATTERN = /\$(\d+)\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)/g;

function refsInString(value: string, origin: string): BatchRef[] {
  const found: BatchRef[] = [];
  for (const match of value.matchAll(REF_PATTERN)) {
    const stepText = match[1];
    const pathText = match[2];
    if (stepText === undefined || pathText === undefined) continue;
    found.push({
      raw: match[0],
      step: Number.parseInt(stepText, 10),
      path: pathText.split("."),
      origin,
    });
  }
  return found;
}

/**
 * Recursively extracts every `$N.key` reference from an arbitrary JSON value
 * (strings are scanned even when embedded in larger sentences). Used by the
 * batch schema and by server-side validation to resolve references before
 * execution. Bare `$N` (no `.key`) is deliberately not extracted — see the
 * file header for the currency-safety rationale.
 */
export function collectRefs(value: unknown, origin = "$"): readonly BatchRef[] {
  const out: BatchRef[] = [];
  const walk = (node: unknown, path: string): void => {
    if (typeof node === "string") {
      out.push(...refsInString(node, path));
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (typeof node === "object" && node !== null) {
      for (const [key, child] of Object.entries(node)) {
        walk(child, path === "$" ? key : `${path}.${key}`);
      }
    }
  };
  walk(value, origin);
  return out;
}

/** A `$N.key` reference that cannot be resolved against a batch's steps. */
export interface BatchRefIssue {
  /** Human-readable step the offending reference lives in (1-based). */
  readonly step: number;
  readonly ref: BatchRef;
  readonly reason: "forward" | "self" | "out_of_range";
}

/**
 * Validates `$N.key` references against 1-based step positions: every
 * reference must point at a *previous* step. Returns all issues (empty ⇒ ok).
 */
export function validateBatchRefs(steps: readonly BatchStep[]): readonly BatchRefIssue[] {
  const issues: BatchRefIssue[] = [];
  steps.forEach((step, index) => {
    const position = index + 1;
    for (const ref of collectRefs(step.params, `steps[${index}].params`)) {
      if (ref.step === position) {
        issues.push({ step: position, ref, reason: "self" });
      } else if (ref.step > position) {
        issues.push({
          step: position,
          ref,
          reason: ref.step > steps.length ? "out_of_range" : "forward",
        });
      } else if (ref.step < 1) {
        issues.push({ step: position, ref, reason: "out_of_range" });
      }
    }
  });
  return issues;
}

// ---------------------------------------------------------------------------
// AgentBatch schema
// ---------------------------------------------------------------------------

/**
 * The batch the bridge sends to `engine.batch` on Apply (§8.4 rule 3, §8.5).
 * Enforces all §8.5 bounds: 1..100 steps, atomic, ≤ 2 MB serialized,
 * ≤ 60 s timeout, and backwards-only `$N.key` references.
 */
export const AGENT_BATCH_SCHEMA = z
  .object({
    label: z.string().min(1).max(MAX_BATCH_LABEL_LENGTH), // "Agent: <summary>"
    atomic: z.literal(true), // non-atomic agent batches are never sent (§8.4)
    steps: z.array(BATCH_STEP_SCHEMA).min(1).max(MAX_BATCH_STEPS),
    timeoutMs: z.number().int().min(1).max(MAX_BATCH_TIMEOUT_MS).optional(),
  })
  .superRefine((batch, ctx) => {
    const serialized = JSON.stringify(batch);
    if (serialized !== undefined && serialized.length > MAX_BATCH_BYTES) {
      ctx.addIssue({
        code: "custom",
        path: ["steps"],
        message: `batch exceeds the ${MAX_BATCH_BYTES}-byte serialized limit (${
          serialized.length
        } bytes)`,
      });
    }
    for (const issue of validateBatchRefs(batch.steps)) {
      ctx.addIssue({
        code: "custom",
        path: ["steps", issue.step - 1, "params"],
        message: `unresolvable $-reference ${issue.ref.raw} in step ${issue.step} (${issue.reason})`,
      });
    }
  });

/** The batch payload sent to the engine (without the `command: "engine.batch"` wrapper). */
export type AgentBatch = z.infer<typeof AGENT_BATCH_SCHEMA>;

// ---------------------------------------------------------------------------
// Batch-created names (2026-11-01 root-cause fix: turn-time layer-ref checks)
// ---------------------------------------------------------------------------

/**
 * Engine commands whose `params.name` CREATES a layer with that name. Shared
 * single source of truth: the gateway uses it to build the turn-local symbol
 * table for turn-time layer-reference validation (an unknown name is a
 * repairable INVALID verdict INSTEAD of an apply-time atomic rollback), and
 * the web apply engine uses it to defer resolution of names the batch itself
 * creates (apply.ts — the names ride through as strings for the engine to
 * resolve at each step's execution time). The two MUST agree, so the regex
 * lives here, not in either consumer.
 */
const BATCH_LAYER_CREATION_RE =
  /^(?:layer\.new(?:3dPrimitive|Adjustment|Camera|Light|Model|Null|Primitive|Shape|Solid|Text))$/;

/** Engine commands whose `params.name` CREATES a composition with that name. */
const BATCH_COMPOSITION_CREATION_RE = /^comp\.new$/;

/** Layer names a batch's own steps create (`layer.new*` with a params.name). */
export function batchCreatedLayerNames(steps: readonly BatchStep[]): ReadonlySet<string> {
  const created = new Set<string>();
  for (const step of steps) {
    if (!BATCH_LAYER_CREATION_RE.test(step.command)) continue;
    const name = step.params.name;
    if (typeof name === "string" && name.length > 0) created.add(name);
  }
  return created;
}

/** Composition names a batch's own steps create (`comp.new` with params.name). */
export function batchCreatedCompositionNames(steps: readonly BatchStep[]): ReadonlySet<string> {
  const created = new Set<string>();
  for (const step of steps) {
    if (!BATCH_COMPOSITION_CREATION_RE.test(step.command)) continue;
    const name = step.params.name;
    if (typeof name === "string" && name.length > 0) created.add(name);
  }
  return created;
}

// ---------------------------------------------------------------------------
// Live-registry types (§8.5: validated against command.describe / JSON Schema)
// ---------------------------------------------------------------------------

/** One parameter descriptor of a live-registry command. */
export interface CommandParamInfo {
  readonly name: string;
  readonly required: boolean;
  /** Coarse JSON-Schema-ish type name, e.g. "string", "number", "object". */
  readonly type?: string;
  readonly description?: string;
}

/** Descriptor for one command in the live EffectCraft registry. */
export interface CommandInfo {
  /** Registry command id, e.g. "comp.new" (authoritative: command.describe). */
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  readonly params?: readonly CommandParamInfo[];
}

/** The live registry surface contracts validate against: id → descriptor. */
export type CommandSchema = Readonly<Record<string, CommandInfo>>;

/** A command-id/param problem found by {@link checkBatchCommands}. */
export interface BatchCommandIssue {
  readonly step: number; // 1-based
  readonly command: string;
  readonly reason: "unknown_command" | "missing_required_param";
  readonly param?: string;
}

/**
 * Pre-flight validation against the live registry (§8.5 "Validated"):
 * every command id must exist and every required param must be present.
 * JSON-Schema-deep param validation stays engine-side (command.describe).
 */
export function checkBatchCommands(
  batch: Readonly<Pick<AgentBatch, "steps">>,
  registry: CommandSchema,
): readonly BatchCommandIssue[] {
  const issues: BatchCommandIssue[] = [];
  batch.steps.forEach((step, index) => {
    const info = registry[step.command];
    if (info === undefined) {
      issues.push({ step: index + 1, command: step.command, reason: "unknown_command" });
      return;
    }
    for (const param of info.params ?? []) {
      if (param.required && !(param.name in step.params)) {
        issues.push({
          step: index + 1,
          command: step.command,
          reason: "missing_required_param",
          param: param.name,
        });
      }
    }
  });
  return issues;
}
