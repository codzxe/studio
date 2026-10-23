import { z } from "zod";
/** Hard cap on the number of steps in one batch (§8.5 "Bounded"). */
export declare const MAX_BATCH_STEPS = 100;
/** Hard cap on the serialized JSON length of one batch (2 MB, §8.5). */
export declare const MAX_BATCH_BYTES: number;
/** Hard cap on batch execution time (60 s, §8.5). */
export declare const MAX_BATCH_TIMEOUT_MS = 60000;
/** Applied when `timeoutMs` is omitted — always the documented ceiling. */
export declare const DEFAULT_BATCH_TIMEOUT_MS = 60000;
/** Suggested cap for the human-readable batch label (`"Agent: <summary>"`). */
export declare const MAX_BATCH_LABEL_LENGTH = 280;
/** One engine command invocation: `command` + `params` (§8.5). */
export declare const BATCH_STEP_SCHEMA: z.ZodObject<{
    command: z.ZodString;
    params: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}, z.core.$strip>;
export type BatchStep = z.infer<typeof BATCH_STEP_SCHEMA>;
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
/**
 * Recursively extracts every `$N.key` reference from an arbitrary JSON value
 * (strings are scanned even when embedded in larger sentences). Used by the
 * batch schema and by server-side validation to resolve references before
 * execution. Bare `$N` (no `.key`) is deliberately not extracted — see the
 * file header for the currency-safety rationale.
 */
export declare function collectRefs(value: unknown, origin?: string): readonly BatchRef[];
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
export declare function validateBatchRefs(steps: readonly BatchStep[]): readonly BatchRefIssue[];
/**
 * The batch the bridge sends to `engine.batch` on Apply (§8.4 rule 3, §8.5).
 * Enforces all §8.5 bounds: 1..100 steps, atomic, ≤ 2 MB serialized,
 * ≤ 60 s timeout, and backwards-only `$N.key` references.
 */
export declare const AGENT_BATCH_SCHEMA: z.ZodObject<{
    label: z.ZodString;
    atomic: z.ZodLiteral<true>;
    steps: z.ZodArray<z.ZodObject<{
        command: z.ZodString;
        params: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, z.core.$strip>>;
    timeoutMs: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
/** The batch payload sent to the engine (without the `command: "engine.batch"` wrapper). */
export type AgentBatch = z.infer<typeof AGENT_BATCH_SCHEMA>;
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
    readonly step: number;
    readonly command: string;
    readonly reason: "unknown_command" | "missing_required_param";
    readonly param?: string;
}
/**
 * Pre-flight validation against the live registry (§8.5 "Validated"):
 * every command id must exist and every required param must be present.
 * JSON-Schema-deep param validation stays engine-side (command.describe).
 */
export declare function checkBatchCommands(batch: Readonly<Pick<AgentBatch, "steps">>, registry: CommandSchema): readonly BatchCommandIssue[];
