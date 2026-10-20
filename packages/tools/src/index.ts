// @studio/tools — public surface for the agent runtime (executor, planner) and
// Wave 5 tool authors. §6: tools wrap engine commands; raw command ids never
// reach the model.

export * from "./types.js";
export * from "./kit.js";
export * from "./registry.js";
export { echoTool, type EchoArgs } from "./example/echo.js";

/**
 * Every registered tool by name, as assembled by the agent runtime.
 * `{ [TOOLS.template_fill]: templateFillTool, … }` — the executor consumes this
 * shape to dispatch parsed calls.
 */
export type ToolMap = Readonly<Record<string, AnyTool>>;
