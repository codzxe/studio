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
const REF_PATTERN = /\$(\d+)\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)/g;
function refsInString(value, origin) {
    const found = [];
    for (const match of value.matchAll(REF_PATTERN)) {
        const stepText = match[1];
        const pathText = match[2];
        if (stepText === undefined || pathText === undefined)
            continue;
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
export function collectRefs(value, origin = "$") {
    const out = [];
    const walk = (node, path) => {
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
/**
 * Validates `$N.key` references against 1-based step positions: every
 * reference must point at a *previous* step. Returns all issues (empty ⇒ ok).
 */
export function validateBatchRefs(steps) {
    const issues = [];
    steps.forEach((step, index) => {
        const position = index + 1;
        for (const ref of collectRefs(step.params, `steps[${index}].params`)) {
            if (ref.step === position) {
                issues.push({ step: position, ref, reason: "self" });
            }
            else if (ref.step > position) {
                issues.push({
                    step: position,
                    ref,
                    reason: ref.step > steps.length ? "out_of_range" : "forward",
                });
            }
            else if (ref.step < 1) {
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
            message: `batch exceeds the ${MAX_BATCH_BYTES}-byte serialized limit (${serialized.length} bytes)`,
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
/**
 * Pre-flight validation against the live registry (§8.5 "Validated"):
 * every command id must exist and every required param must be present.
 * JSON-Schema-deep param validation stays engine-side (command.describe).
 */
export function checkBatchCommands(batch, registry) {
    const issues = [];
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
//# sourceMappingURL=engine-batch.js.map