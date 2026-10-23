import { z } from "zod";
import { type EditPlan } from "./edit-plan.js";
export declare const RUN_STARTED_EVENT_SCHEMA: z.ZodObject<{
    type: z.ZodLiteral<"run.started">;
    runId: z.ZodString;
    seq: z.ZodNumber;
    model: z.ZodString;
}, z.core.$strip>;
export declare const MESSAGE_DELTA_EVENT_SCHEMA: z.ZodObject<{
    type: z.ZodLiteral<"message.delta">;
    runId: z.ZodString;
    seq: z.ZodNumber;
    delta: z.ZodString;
}, z.core.$strip>;
export declare const TOOL_STARTED_EVENT_SCHEMA: z.ZodObject<{
    type: z.ZodLiteral<"tool.started">;
    runId: z.ZodString;
    seq: z.ZodNumber;
    toolCallId: z.ZodString;
    name: z.ZodString;
    args: z.ZodUnknown;
}, z.core.$strip>;
export declare const TOOL_DELTA_EVENT_SCHEMA: z.ZodObject<{
    type: z.ZodLiteral<"tool.delta">;
    runId: z.ZodString;
    seq: z.ZodNumber;
    toolCallId: z.ZodString;
    delta: z.ZodString;
}, z.core.$strip>;
export declare const TOOL_RESULT_EVENT_SCHEMA: z.ZodObject<{
    type: z.ZodLiteral<"tool.result">;
    runId: z.ZodString;
    seq: z.ZodNumber;
    toolCallId: z.ZodString;
    result: z.ZodUnknown;
}, z.core.$strip>;
/**
 * One layer-id disambiguation request emitted by the server-side plan
 * compiler (M5-SEAMS): the compiled batch references a layer BY NAME and the
 * CLIENT resolves the id via the bridge (`list_layers`) when applying —
 * layer ids never enter the model context (§8.7).
 */
export declare const LAYER_RESOLUTION_REQUEST_SCHEMA: z.ZodObject<{
    requestId: z.ZodString;
    layerName: z.ZodString;
    disambiguation: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
export type LayerResolutionRequest = z.infer<typeof LAYER_RESOLUTION_REQUEST_SCHEMA>;
/** M5.6 (§7.3): the auto-apply verdict modes — "auto" arms the card, never
 * bypasses the Apply click (D-22 candidate ruling, worklog M5-O). */
export declare const AUTO_APPLY_MODE_SCHEMA: z.ZodEnum<{
    auto: "auto";
    propose: "propose";
}>;
/**
 * M5.6 auto-apply verdict (BUILD_PLAN §M5 task 6, EDITOR_CHAT_UX §7.3 — off
 * by default): the gateway's SERVER-SIDE decision attached to the plan event.
 * `reason` is a stable, human-safe policy CODE from the gateway's decision
 * module (services/gateway/src/auto-apply.ts — never stack traces, paths or
 * internal ids, law #1); clients own their human copy per reason.
 */
export declare const PLAN_AUTO_APPLY_SCHEMA: z.ZodObject<{
    mode: z.ZodEnum<{
        auto: "auto";
        propose: "propose";
    }>;
    reason: z.ZodString;
}, z.core.$strip>;
export type PlanAutoApplyDecision = z.infer<typeof PLAN_AUTO_APPLY_SCHEMA>;
export declare const PLAN_EVENT_SCHEMA: z.ZodObject<{
    type: z.ZodLiteral<"plan">;
    runId: z.ZodString;
    seq: z.ZodNumber;
    plan: z.ZodObject<{
        intent: z.ZodEnum<{
            render: "render";
            create: "create";
            edit: "edit";
            animate: "animate";
            style: "style";
            organize: "organize";
            explain: "explain";
            clarify: "clarify";
        }>;
        summary: z.ZodString;
        risk: z.ZodEnum<{
            low: "low";
            medium: "medium";
            high: "high";
        }>;
        requiresApproval: z.ZodBoolean;
        affectedLayers: z.ZodArray<z.ZodObject<{
            id: z.ZodOptional<z.ZodNumber>;
            name: z.ZodString;
            change: z.ZodString;
        }, z.core.$strip>>;
        estimatedCredits: z.ZodNumber;
        steps: z.ZodArray<z.ZodObject<{
            title: z.ZodString;
            tool: z.ZodString;
            args: z.ZodUnknown;
            batch: z.ZodObject<{
                label: z.ZodString;
                steps: z.ZodArray<z.ZodObject<{
                    command: z.ZodString;
                    params: z.ZodRecord<z.ZodString, z.ZodUnknown>;
                }, z.core.$strip>>;
            }, z.core.$strip>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    compiledBatch: z.ZodOptional<z.ZodObject<{
        label: z.ZodString;
        atomic: z.ZodLiteral<true>;
        steps: z.ZodArray<z.ZodObject<{
            command: z.ZodString;
            params: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        }, z.core.$strip>>;
        timeoutMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    resolutionRequests: z.ZodOptional<z.ZodArray<z.ZodObject<{
        requestId: z.ZodString;
        layerName: z.ZodString;
        disambiguation: z.ZodArray<z.ZodString>;
    }, z.core.$strip>>>;
    risk: z.ZodOptional<z.ZodEnum<{
        low: "low";
        medium: "medium";
        high: "high";
    }>>;
    estimatedCredits: z.ZodOptional<z.ZodNumber>;
    baseVersionId: z.ZodOptional<z.ZodString>;
    autoApply: z.ZodOptional<z.ZodObject<{
        mode: z.ZodEnum<{
            auto: "auto";
            propose: "propose";
        }>;
        reason: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const PREVIEW_EVENT_SCHEMA: z.ZodObject<{
    type: z.ZodLiteral<"preview">;
    runId: z.ZodString;
    seq: z.ZodNumber;
    pngBase64: z.ZodString;
    width: z.ZodNumber;
    height: z.ZodNumber;
}, z.core.$strip>;
export declare const APPROVAL_REQUIRED_EVENT_SCHEMA: z.ZodObject<{
    type: z.ZodLiteral<"approval.required">;
    runId: z.ZodString;
    seq: z.ZodNumber;
    plan: z.ZodObject<{
        intent: z.ZodEnum<{
            render: "render";
            create: "create";
            edit: "edit";
            animate: "animate";
            style: "style";
            organize: "organize";
            explain: "explain";
            clarify: "clarify";
        }>;
        summary: z.ZodString;
        risk: z.ZodEnum<{
            low: "low";
            medium: "medium";
            high: "high";
        }>;
        requiresApproval: z.ZodBoolean;
        affectedLayers: z.ZodArray<z.ZodObject<{
            id: z.ZodOptional<z.ZodNumber>;
            name: z.ZodString;
            change: z.ZodString;
        }, z.core.$strip>>;
        estimatedCredits: z.ZodNumber;
        steps: z.ZodArray<z.ZodObject<{
            title: z.ZodString;
            tool: z.ZodString;
            args: z.ZodUnknown;
            batch: z.ZodObject<{
                label: z.ZodString;
                steps: z.ZodArray<z.ZodObject<{
                    command: z.ZodString;
                    params: z.ZodRecord<z.ZodString, z.ZodUnknown>;
                }, z.core.$strip>>;
            }, z.core.$strip>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const CREDITS_EVENT_SCHEMA: z.ZodObject<{
    type: z.ZodLiteral<"credits">;
    runId: z.ZodString;
    seq: z.ZodNumber;
    reserved: z.ZodNumber;
    committed: z.ZodNumber;
    balance: z.ZodNumber;
}, z.core.$strip>;
export declare const RUN_COMPLETED_EVENT_SCHEMA: z.ZodObject<{
    type: z.ZodLiteral<"run.completed">;
    runId: z.ZodString;
    seq: z.ZodNumber;
    versionId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const RUN_FAILED_EVENT_SCHEMA: z.ZodObject<{
    type: z.ZodLiteral<"run.failed">;
    runId: z.ZodString;
    seq: z.ZodNumber;
    code: z.ZodString;
    message: z.ZodString;
    retryable: z.ZodBoolean;
}, z.core.$strip>;
export declare const RUN_CANCELLED_EVENT_SCHEMA: z.ZodObject<{
    type: z.ZodLiteral<"run.cancelled">;
    runId: z.ZodString;
    seq: z.ZodNumber;
}, z.core.$strip>;
/** All 12 §7.4 event types, in wire order. */
export declare const STUDIO_STREAM_EVENT_TYPES: readonly ["run.started", "message.delta", "tool.started", "tool.delta", "tool.result", "plan", "preview", "approval.required", "credits", "run.completed", "run.failed", "run.cancelled"];
export type StudioStreamEventType = (typeof STUDIO_STREAM_EVENT_TYPES)[number];
export declare const STUDIO_STREAM_EVENT_SCHEMA: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"run.started">;
    runId: z.ZodString;
    seq: z.ZodNumber;
    model: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"message.delta">;
    runId: z.ZodString;
    seq: z.ZodNumber;
    delta: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"tool.started">;
    runId: z.ZodString;
    seq: z.ZodNumber;
    toolCallId: z.ZodString;
    name: z.ZodString;
    args: z.ZodUnknown;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"tool.delta">;
    runId: z.ZodString;
    seq: z.ZodNumber;
    toolCallId: z.ZodString;
    delta: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"tool.result">;
    runId: z.ZodString;
    seq: z.ZodNumber;
    toolCallId: z.ZodString;
    result: z.ZodUnknown;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"plan">;
    runId: z.ZodString;
    seq: z.ZodNumber;
    plan: z.ZodObject<{
        intent: z.ZodEnum<{
            render: "render";
            create: "create";
            edit: "edit";
            animate: "animate";
            style: "style";
            organize: "organize";
            explain: "explain";
            clarify: "clarify";
        }>;
        summary: z.ZodString;
        risk: z.ZodEnum<{
            low: "low";
            medium: "medium";
            high: "high";
        }>;
        requiresApproval: z.ZodBoolean;
        affectedLayers: z.ZodArray<z.ZodObject<{
            id: z.ZodOptional<z.ZodNumber>;
            name: z.ZodString;
            change: z.ZodString;
        }, z.core.$strip>>;
        estimatedCredits: z.ZodNumber;
        steps: z.ZodArray<z.ZodObject<{
            title: z.ZodString;
            tool: z.ZodString;
            args: z.ZodUnknown;
            batch: z.ZodObject<{
                label: z.ZodString;
                steps: z.ZodArray<z.ZodObject<{
                    command: z.ZodString;
                    params: z.ZodRecord<z.ZodString, z.ZodUnknown>;
                }, z.core.$strip>>;
            }, z.core.$strip>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    compiledBatch: z.ZodOptional<z.ZodObject<{
        label: z.ZodString;
        atomic: z.ZodLiteral<true>;
        steps: z.ZodArray<z.ZodObject<{
            command: z.ZodString;
            params: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        }, z.core.$strip>>;
        timeoutMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    resolutionRequests: z.ZodOptional<z.ZodArray<z.ZodObject<{
        requestId: z.ZodString;
        layerName: z.ZodString;
        disambiguation: z.ZodArray<z.ZodString>;
    }, z.core.$strip>>>;
    risk: z.ZodOptional<z.ZodEnum<{
        low: "low";
        medium: "medium";
        high: "high";
    }>>;
    estimatedCredits: z.ZodOptional<z.ZodNumber>;
    baseVersionId: z.ZodOptional<z.ZodString>;
    autoApply: z.ZodOptional<z.ZodObject<{
        mode: z.ZodEnum<{
            auto: "auto";
            propose: "propose";
        }>;
        reason: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"preview">;
    runId: z.ZodString;
    seq: z.ZodNumber;
    pngBase64: z.ZodString;
    width: z.ZodNumber;
    height: z.ZodNumber;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"approval.required">;
    runId: z.ZodString;
    seq: z.ZodNumber;
    plan: z.ZodObject<{
        intent: z.ZodEnum<{
            render: "render";
            create: "create";
            edit: "edit";
            animate: "animate";
            style: "style";
            organize: "organize";
            explain: "explain";
            clarify: "clarify";
        }>;
        summary: z.ZodString;
        risk: z.ZodEnum<{
            low: "low";
            medium: "medium";
            high: "high";
        }>;
        requiresApproval: z.ZodBoolean;
        affectedLayers: z.ZodArray<z.ZodObject<{
            id: z.ZodOptional<z.ZodNumber>;
            name: z.ZodString;
            change: z.ZodString;
        }, z.core.$strip>>;
        estimatedCredits: z.ZodNumber;
        steps: z.ZodArray<z.ZodObject<{
            title: z.ZodString;
            tool: z.ZodString;
            args: z.ZodUnknown;
            batch: z.ZodObject<{
                label: z.ZodString;
                steps: z.ZodArray<z.ZodObject<{
                    command: z.ZodString;
                    params: z.ZodRecord<z.ZodString, z.ZodUnknown>;
                }, z.core.$strip>>;
            }, z.core.$strip>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"credits">;
    runId: z.ZodString;
    seq: z.ZodNumber;
    reserved: z.ZodNumber;
    committed: z.ZodNumber;
    balance: z.ZodNumber;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"run.completed">;
    runId: z.ZodString;
    seq: z.ZodNumber;
    versionId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"run.failed">;
    runId: z.ZodString;
    seq: z.ZodNumber;
    code: z.ZodString;
    message: z.ZodString;
    retryable: z.ZodBoolean;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"run.cancelled">;
    runId: z.ZodString;
    seq: z.ZodNumber;
}, z.core.$strip>], "type">;
export type StudioStreamEvent = z.infer<typeof STUDIO_STREAM_EVENT_SCHEMA>;
export declare function isStudioStreamEvent(value: unknown): value is StudioStreamEvent;
export declare const RUN_STATUSES: readonly ["idle", "sending", "streaming", "awaiting_approval", "applying", "applied", "undoing", "undone", "cancelling", "cancelled", "failed"];
export type RunStatus = (typeof RUN_STATUSES)[number];
/** Live tool-call card (EDITOR_CHAT_UX §6.1): cards appear as the call starts. */
export interface ToolCallState {
    readonly toolCallId: string;
    readonly name: string;
    readonly status: "running" | "done";
    readonly args?: unknown;
    readonly deltaText: string;
    readonly result?: unknown;
}
/** Latest `preview` frame (§7.4). */
export interface RunPreviewState {
    readonly pngBase64: string;
    readonly width: number;
    readonly height: number;
    readonly seq: number;
}
/** Latest `credits` snapshot (§7.4). */
export interface RunCreditsState {
    readonly reserved: number;
    readonly committed: number;
    readonly balance: number;
    readonly seq: number;
}
/** Terminal `run.failed` payload (§7.4). */
export interface RunErrorState {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
}
/** Everything the chat panel tracks for one run. */
export interface RunState {
    readonly runId: string | null;
    readonly status: RunStatus;
    readonly model: string | null;
    readonly text: string;
    readonly toolCalls: readonly ToolCallState[];
    readonly plan: EditPlan | null;
    readonly approvalRequired: boolean;
    readonly preview: RunPreviewState | null;
    readonly credits: RunCreditsState | null;
    readonly versionId: string | null;
    readonly error: RunErrorState | null;
    /** Highest accepted event seq; `-1` before the first event. */
    readonly lastSeq: number;
}
export declare const INITIAL_RUN_STATE: RunState;
/**
 * Client-driven transitions (§8.1 states driven by the user, not the stream):
 * submit a new message, Apply, undo, cancel. SSE-independent, so they never
 * consume a seq.
 */
export type RunClientAction = {
    readonly type: "run.submit";
} | {
    readonly type: "run.apply";
} | {
    readonly type: "run.applied";
    readonly versionId?: string;
} | {
    readonly type: "run.undo";
} | {
    readonly type: "run.undone";
} | {
    readonly type: "run.cancel";
};
export type RunStateInput = StudioStreamEvent | RunClientAction;
/**
 * Pure reducer for a client run state machine (§8.1): folds one stream event or
 * client action into `state`. Total (never throws) and immutable; invalid
 * transitions are no-ops.
 */
export declare function applyEvents(state: RunState, input: RunStateInput): RunState;
/** Convenience fold: `reduceEvents(events)` over `INITIAL_RUN_STATE`. */
export declare function reduceEvents(inputs: Iterable<RunStateInput>, initial?: RunState): RunState;
