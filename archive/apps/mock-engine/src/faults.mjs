// @ts-check
/**
 * Env-driven fault injection for chaos tests: `MOCK_FAULT=crash-on-command|hang|oversized-reply`.
 * Hooks fire on every `engine.execute` dispatch, before the command runs
 * (docs/control-protocol.md › Engine commands). Zero dependencies.
 */
import process from "node:process";

/** @typedef {"crash-on-command" | "hang" | "oversized-reply"} FaultMode */

/** The recognized `MOCK_FAULT` values (anything else is ignored). */
export const FAULT_MODES = /** @type {const} */ (["crash-on-command", "hang", "oversized-reply"]);

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {FaultMode | ""}
 */
export function activeFault(env = process.env) {
  const v = env.MOCK_FAULT ?? "";
  return /** @type {any} */ (FAULT_MODES).includes(v) ? v : "";
}

/**
 * What to do before a dispatched command runs. The caller performs the action:
 * `exit` → `process.exit(86)` (engine hard-crash), `hang` → write no reply at all,
 * `oversized` → write a well-formed reply far past the protocol's 8 MiB reply ceiling.
 * @param {FaultMode | ""} fault
 * @returns {"exit" | "hang" | "oversized" | null}
 */
export function beforeCommand(fault) {
  if (fault === "crash-on-command") return "exit";
  if (fault === "hang") return "hang";
  if (fault === "oversized-reply") return "oversized";
  return null;
}

/**
 * A >8 MiB encoded reply line (9 MiB of padding) for `MOCK_FAULT=oversized-reply`,
 * testing the client's reply-budget handling (protocol › Transport limits).
 * @param {unknown} id
 * @returns {string}
 */
export function oversizedReply(id) {
  return JSON.stringify({ id, ok: true, result: { pad: "x".repeat(9 * 1024 * 1024) } }) + "\n";
}
