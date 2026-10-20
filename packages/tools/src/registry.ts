// @studio/tools — ToolRegistry: what the planner sees, what the executor dispatches to.
//
// The registry is deliberately dumb: name → tool, duplicate rejection, and
// `name + description` listings ONLY — full argument schemas never enter prompts
// (§6.1; the executor parses raw args with `parseToolArgs` instead).

import { z } from "zod";
import { isToolName } from "./kit.js";
import type { AnyTool, ToolErr } from "./types.js";

// ---------------------------------------------------------------------------
// The §6 tool surface — the only names the planner may be offered.
// ---------------------------------------------------------------------------

/**
 * §6 tool names as a const object (keys === values). Includes the four
 * model-orchestrated tools (`workspace_snapshot`, `brief_to_plan`,
 * `vision_critique`, `ask_user`) that make no engine call.
 */
export const TOOLS = {
  workspace_snapshot: "workspace_snapshot",
  brief_to_plan: "brief_to_plan",
  template_list: "template_list",
  template_inspect: "template_inspect",
  template_apply: "template_apply",
  template_fill: "template_fill",
  asset_search: "asset_search",
  asset_place: "asset_place",
  image_generate: "image_generate",
  text_set: "text_set",
  layer_ops: "layer_ops",
  style_apply: "style_apply",
  layout_apply: "layout_apply",
  component_list: "component_list",
  component_place: "component_place",
  component_set_vars: "component_set_vars",
  render_preview: "render_preview",
  validate_document: "validate_document",
  vision_critique: "vision_critique",
  variant_create: "variant_create",
  export_document: "export_document",
  ask_user: "ask_user",
} as const;

export type ToolName = keyof typeof TOOLS;

// ---------------------------------------------------------------------------
// Registry result types (typed envelopes; never throws — §6.1)
// ---------------------------------------------------------------------------

/** Planner-facing listing: name + description only. */
export interface ToolListing {
  readonly name: string;
  readonly description: string;
}

export interface UnknownToolError extends Omit<ToolErr, "code" | "retryable"> {
  readonly code: "unknown_tool";
  /** Every registered name, so the planner can correct itself in one hop. */
  readonly allowed: readonly string[];
  readonly retryable: false;
}

export type ToolLookup = { readonly ok: true; readonly tool: AnyTool } | UnknownToolError;

export interface RegisterRejected {
  readonly ok: false;
  readonly code: "duplicate_tool" | "invalid_tool_name" | "internal_error";
  readonly message: string;
  readonly hint: string;
  readonly retryable: false;
}

export type RegisterOutcome = { readonly ok: true } | RegisterRejected;

export interface ToolRegistryOptions {
  /**
   * When set, only these names may register — pin the surface with
   * `Object.values(TOOLS)` so a typo can never ship under an invented name (§6).
   */
  readonly allowedNames?: readonly string[];
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();
  private readonly allowedNames: ReadonlySet<string> | undefined;

  constructor(options: ToolRegistryOptions = {}) {
    this.allowedNames =
      options.allowedNames === undefined ? undefined : new Set(options.allowedNames);
  }

  /** Registers a tool; duplicate names and non-§6 names are rejected as envelopes. */
  register(tool: AnyTool): RegisterOutcome {
    const name = typeof tool?.name === "string" ? tool.name : "";
    if (!isToolName(name)) {
      return {
        ok: false,
        code: "invalid_tool_name",
        message: `Tool name must be snake_case (a-z, 0-9, _), got "${name.slice(0, 64)}"`,
        hint: "Names mirror the §6 surface, e.g. template_fill.",
        retryable: false,
      };
    }
    if (this.allowedNames !== undefined && !this.allowedNames.has(name)) {
      return {
        ok: false,
        code: "invalid_tool_name",
        message: `Tool "${name}" is not part of the pinned tool surface`,
        hint: "Extend TOOLS (§6) or construct the registry without allowedNames.",
        retryable: false,
      };
    }
    if (
      tool.args == null ||
      !(tool.args instanceof z.ZodType) ||
      typeof tool.run !== "function" ||
      typeof tool.description !== "string" ||
      tool.description.trim().length === 0
    ) {
      return {
        ok: false,
        code: "internal_error",
        message: `Tool "${name}" must carry a Zod args schema, a run function, and a description`,
        hint: "Build tools with defineTool so the contract is enforced (§6.2).",
        retryable: false,
      };
    }
    if (this.tools.has(name)) {
      return {
        ok: false,
        code: "duplicate_tool",
        message: `Tool "${name}" is already registered`,
        hint: "One name maps to exactly one implementation (§6).",
        retryable: false,
      };
    }
    this.tools.set(name, tool);
    return { ok: true };
  }

  /** Typed lookup: the tool, or `unknown_tool` with the allowed list. */
  get(name: string): ToolLookup {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      const allowed = Object.freeze([...this.tools.keys()]);
      return {
        ok: false,
        code: "unknown_tool",
        message: `Unknown tool "${name.slice(0, 64)}"`,
        hint:
          this.tools.size > 0
            ? `Available tools: ${allowed.join(", ")}`
            : "No tools are registered yet.",
        allowed,
        retryable: false,
      };
    }
    return { ok: true, tool };
  }

  /** Planner context: name + description only — never full schemas in prompts (§6.1). */
  list(): readonly ToolListing[] {
    return Object.freeze(
      [...this.tools.values()].map((tool) =>
        Object.freeze({ name: tool.name, description: tool.description }),
      ),
    );
  }

  names(): readonly string[] {
    return Object.freeze([...this.tools.keys()]);
  }

  size(): number {
    return this.tools.size;
  }

  /** Ready-to-embed planner block: `- name — description` lines. */
  promptBlock(): string {
    return this.list()
      .map((tool) => `${tool.name} — ${tool.description}`)
      .join("\n");
  }
}
