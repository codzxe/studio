// @studio/contracts — agent runs (PRODUCT_ARCHITECTURE.md §7.2, §8.7, §9.1 `agent_runs`).
//
// `POST /v1/runs/:id/events`: the client reports a tool result (only for the
// expected toolCallId, §7.4) or the apply result + sha256 of the new project
// bytes (§8.7: "client posts run result + sha256 to gateway").
// `GET /v1/runs/:id`: run + steps + credits. `POST /v1/runs/:id/cancel`: cancel.
import { z } from "zod";
import { ID_SCHEMA, SHA256_SCHEMA } from "./common.js";
/** Server-side run status persisted on `agent_runs.status` (§9.1). */
export const SERVER_RUN_STATUSES = [
    "queued",
    "streaming",
    "awaiting_approval",
    "applying",
    "completed",
    "failed",
    "cancelled",
];
/** Tool result reported by the editor bridge (§7.4 run-token + toolCallId rule). */
export const TOOL_RESULT_EVENT_REQUEST_SCHEMA = z.strictObject({
    type: z.literal("tool.result"),
    toolCallId: z.string().min(1),
    result: z.unknown(),
});
/** Apply result reported after engine.batch (§8.7; sha256 of new bytes). */
export const APPLY_RESULT_EVENT_REQUEST_SCHEMA = z
    .strictObject({
    type: z.literal("apply.result"),
    ok: z.boolean(),
    sha256: SHA256_SCHEMA.optional(), // required when ok === true
    versionLabel: z.string().max(280).optional(),
    errorCode: z.string().min(1).optional(), // required when ok === false
    errorMessage: z.string().min(1).optional(),
})
    .refine((body) => (body.ok ? body.sha256 !== undefined : body.errorCode !== undefined), "sha256 is required on success; errorCode on failure");
/** `POST /v1/runs/:id/events` body (§7.2 "Client tool result / apply result"). */
export const RUN_EVENT_REQUEST_SCHEMA = z.discriminatedUnion("type", [
    TOOL_RESULT_EVENT_REQUEST_SCHEMA,
    APPLY_RESULT_EVENT_REQUEST_SCHEMA,
]);
/** `POST /v1/runs/:id/cancel` body. */
export const CANCEL_RUN_SCHEMA = z.strictObject({
    reason: z.string().max(280).optional(),
});
export const RUN_ID_SCHEMA = ID_SCHEMA;
//# sourceMappingURL=runs.js.map