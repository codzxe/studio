import { z } from "zod";
import type { PlanRisk } from "./edit-plan.js";
export declare const TOOL_IDS: readonly ["studio.get_context", "studio.list_layers", "studio.get_properties", "studio.plan_edit", "studio.render_preview", "studio.create_composition", "studio.create_text", "studio.set_properties", "studio.add_effect", "studio.set_keyframes", "studio.apply_preset", "studio.undo_run", "studio.save_version"];
export type ToolId = (typeof TOOL_IDS)[number];
export declare const TOOL_ID_SCHEMA: z.ZodEnum<{
    "studio.create_composition": "studio.create_composition";
    "studio.create_text": "studio.create_text";
    "studio.set_properties": "studio.set_properties";
    "studio.add_effect": "studio.add_effect";
    "studio.set_keyframes": "studio.set_keyframes";
    "studio.apply_preset": "studio.apply_preset";
    "studio.undo_run": "studio.undo_run";
    "studio.save_version": "studio.save_version";
    "studio.get_context": "studio.get_context";
    "studio.list_layers": "studio.list_layers";
    "studio.get_properties": "studio.get_properties";
    "studio.plan_edit": "studio.plan_edit";
    "studio.render_preview": "studio.render_preview";
}>;
export type ToolKind = "read" | "write";
/** What a tool call yields: read tools return data; write tools return a
 * proposed `engine.batch` payload (never an execution). */
export type ToolReturns = "data" | "proposed-batch";
export interface ToolDefinition {
    readonly id: ToolId;
    readonly kind: ToolKind;
    readonly risk: PlanRisk;
    /** Model-facing description. No command ids, no engine internals. */
    readonly description: string;
    /** Args stub the gateway validates before the tool runs. */
    readonly args: z.ZodType<unknown>;
    readonly returns: ToolReturns;
}
export declare const TOOL_LIST: readonly ToolDefinition[];
export declare const TOOL_CATALOG: Readonly<Record<ToolId, ToolDefinition>>;
/** Look up a tool by id; `undefined` for unknown tools (never fall back). */
export declare function getTool(id: string): ToolDefinition | undefined;
/** `true` for proposal-only tools (§8.4 rule 1: write tools return batches). */
export declare function isWriteTool(id: ToolId): boolean;
export declare function isReadTool(id: ToolId): boolean;
