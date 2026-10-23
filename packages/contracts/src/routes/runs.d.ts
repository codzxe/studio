import { z } from "zod";
import type { EditPlan } from "../edit-plan.js";
import type { ModelId } from "../models.js";
import { type Id } from "./common.js";
/** Server-side run status persisted on `agent_runs.status` (§9.1). */
export declare const SERVER_RUN_STATUSES: readonly ["queued", "streaming", "awaiting_approval", "applying", "completed", "failed", "cancelled"];
export type ServerRunStatus = (typeof SERVER_RUN_STATUSES)[number];
/** Tool result reported by the editor bridge (§7.4 run-token + toolCallId rule). */
export declare const TOOL_RESULT_EVENT_REQUEST_SCHEMA: z.ZodObject<{
    type: z.ZodLiteral<"tool.result">;
    toolCallId: z.ZodString;
    result: z.ZodUnknown;
}, z.core.$strict>;
/** Apply result reported after engine.batch (§8.7; sha256 of new bytes). */
export declare const APPLY_RESULT_EVENT_REQUEST_SCHEMA: z.ZodObject<{
    type: z.ZodLiteral<"apply.result">;
    ok: z.ZodBoolean;
    sha256: z.ZodOptional<z.ZodString>;
    versionLabel: z.ZodOptional<z.ZodString>;
    errorCode: z.ZodOptional<z.ZodString>;
    errorMessage: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
/** `POST /v1/runs/:id/events` body (§7.2 "Client tool result / apply result"). */
export declare const RUN_EVENT_REQUEST_SCHEMA: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"tool.result">;
    toolCallId: z.ZodString;
    result: z.ZodUnknown;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"apply.result">;
    ok: z.ZodBoolean;
    sha256: z.ZodOptional<z.ZodString>;
    versionLabel: z.ZodOptional<z.ZodString>;
    errorCode: z.ZodOptional<z.ZodString>;
    errorMessage: z.ZodOptional<z.ZodString>;
}, z.core.$strict>], "type">;
export type RunEventRequest = z.infer<typeof RUN_EVENT_REQUEST_SCHEMA>;
/** `POST /v1/runs/:id/cancel` body. */
export declare const CANCEL_RUN_SCHEMA: z.ZodObject<{
    reason: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type CancelRunRequest = z.infer<typeof CANCEL_RUN_SCHEMA>;
/** One `agent_steps` row (§9.1). */
export interface RunStepRecord {
    readonly seq: number;
    readonly tool: string;
    readonly status: "started" | "succeeded" | "failed" | "skipped";
    readonly durationMs: number | null;
}
/** `GET /v1/runs/:id` → run + steps + credits (§7.2). */
export interface RunRecord {
    readonly id: Id;
    readonly threadId: Id;
    readonly projectId: Id;
    readonly model: ModelId;
    readonly status: ServerRunStatus;
    readonly plan: EditPlan | null;
    readonly steps: readonly RunStepRecord[];
    readonly reservedCredits: number;
    readonly committedCredits: number | null;
    readonly baseVersionId: Id | null;
    readonly resultVersionId: Id | null;
    readonly errorCode: string | null;
    readonly createdAt: string;
    readonly completedAt: string | null;
}
export declare const RUN_ID_SCHEMA: z.ZodString;
