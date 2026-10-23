import { z } from "zod";
/** Message bodies are bounded; larger prompts are a client-side UX problem. */
export declare const CHAT_MESSAGE_SCHEMA: z.ZodString;
/**
 * `POST /v1/threads/:id/chat` body (§7.2): the user message, the context
 * selection for this message (EDITOR_CHAT_UX §5) and an idempotency key so a
 * retry never duplicates a run (§8.4 reconnect rules).
 *
 * `model` is OPTIONAL (§8.2 plan gating): unset → the plan's default model;
 * set but not entitled on the workspace's plan → MODEL_NOT_ENTITLED (403).
 * M4-SEAMS Seam 1.
 */
export declare const CHAT_REQUEST_SCHEMA: z.ZodObject<{
    message: z.ZodString;
    context: z.ZodObject<{
        projectSummary: z.ZodDefault<z.ZodBoolean>;
        activeComp: z.ZodDefault<z.ZodBoolean>;
        selection: z.ZodDefault<z.ZodBoolean>;
        playhead: z.ZodDefault<z.ZodBoolean>;
        focusedPanel: z.ZodDefault<z.ZodBoolean>;
        selectedProperties: z.ZodDefault<z.ZodBoolean>;
        currentFrame: z.ZodDefault<z.ZodBoolean>;
        recentCommands: z.ZodDefault<z.ZodBoolean>;
        comments: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strict>;
    idempotencyKey: z.ZodString;
    pinned: z.ZodDefault<z.ZodArray<z.ZodObject<{
        kind: z.ZodEnum<{
            asset: "asset";
            comment: "comment";
            selection: "selection";
            frame: "frame";
            composition: "composition";
        }>;
        id: z.ZodOptional<z.ZodString>;
        label: z.ZodString;
    }, z.core.$strict>>>;
    model: z.ZodOptional<z.ZodEnum<{
        "studio-fast": "studio-fast";
        "studio-smart": "studio-smart";
        "studio-vision": "studio-vision";
    }>>;
}, z.core.$strict>;
export type ChatRequest = z.infer<typeof CHAT_REQUEST_SCHEMA>;
