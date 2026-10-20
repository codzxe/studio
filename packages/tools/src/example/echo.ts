// @studio/tools — the reference tool for Wave 5 authors.
//
// `echo` demonstrates the FULL §6 contract on ~40 lines:
//   - strict schema built from kit helpers (`strictObject`, `cappedString`, `zColor`)
//   - `.default()` on a field (parsed input ≠ output — the reason `Tool.args`
//     types its input as `unknown`)
//   - `ok()` compact result / `err()` actionable failure
//   - ctx + signal used the way real tools use them
//
// Not part of the §6 surface: it is never registered in production registries.
// Copy this shape for `template_fill` and friends (packages/tools/README.md).

import { z } from "zod";
import { cappedString, defineTool, err, ok, strictObject, zColor } from "../kit.js";
import type { Tool } from "../types.js";

/** Explicit argument type: matches the schema's OUTPUT type (after `.default()` applies). */
export interface EchoArgs {
  readonly message: string;
  readonly color?: string;
  readonly mode: "ok" | "fail";
}

export const echoTool: Tool<EchoArgs> = defineTool({
  name: "echo",
  description: "Echoes a short message back with a timestamp. Reference example for the tool contract (§6.2).",
  args: strictObject({
    message: cappedString(200),
    color: zColor.optional(),
    mode: z.enum(["ok", "fail"]).default("ok"),
  }),
  async run(ctx, args) {
    // Failures are values (§6.1): actionable code, a message, and a fix hint.
    if (args.mode === "fail") {
      return err("validation_failed", "Echo failed on purpose", {
        hint: 'Set mode to "ok" to succeed.',
        retryable: false,
      });
    }
    // ctx.logger for structured breadcrumbs only — never tokens or paths (§22).
    ctx.logger.debug("echo invoked", { characters: args.message.length, hasColor: args.color !== undefined });
    return ok({
      // §6.1 small reply: what changed and what's next — not an engine dump.
      summary: args.color === undefined ? args.message : `${args.message} (${args.color})`,
      warnings:
        args.message.length > 100
          ? ["Message near the 200-char cap; real tools keep summaries much smaller (§6.1)"]
          : undefined,
    });
  },
});
