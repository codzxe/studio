import { z } from "zod";
import { type Id } from "./common.js";
export declare const THREAD_TITLE_SCHEMA: z.ZodString;
/** `POST /v1/projects/:id/threads` body (projectId in path). */
export declare const CREATE_THREAD_SCHEMA: z.ZodObject<{
    title: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type CreateThreadRequest = z.infer<typeof CREATE_THREAD_SCHEMA>;
/** Thread row (§9.1 `agent_threads`). */
export interface Thread {
    readonly id: Id;
    readonly projectId: Id;
    readonly title: string | null;
    readonly createdBy: Id;
    readonly createdAt: string;
    readonly updatedAt: string;
}
export declare const THREAD_MESSAGE_ROLE_SCHEMA: z.ZodEnum<{
    user: "user";
    assistant: "assistant";
    system: "system";
}>;
export type ThreadMessageRole = z.infer<typeof THREAD_MESSAGE_ROLE_SCHEMA>;
/** Message row (§9.1 `agent_messages`; content_json stays opaque here). */
export interface ThreadMessage {
    readonly id: Id;
    readonly threadId: Id;
    readonly role: ThreadMessageRole;
    readonly content: unknown;
    readonly runId: Id | null;
    readonly createdAt: string;
}
export declare const THREAD_ID_SCHEMA: z.ZodString;
