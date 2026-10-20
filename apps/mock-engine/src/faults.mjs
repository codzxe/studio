// @studio/mock-engine — fault injection hooks for integration tests.
//
// The real headless server (vendor/photocraft `photocraft-cli serve`) never misbehaves on
// purpose, but the studio spine (W2-J) must survive the ways a real engine process can fail:
// a hard crash mid-command, a method that never replies (client timeout path), and a reply
// too large for the transport (the 8 MiB reply ceiling in docs/control-protocol.md ›
// Transport limits). This module is mock-only and has no vendor counterpart.
//
// Faults are configured two ways:
//   1. at launch: MOCK_ENGINE_FAULTS='<json>' (see README.md › Fault hooks)
//   2. at runtime: the mock-only `mock.faults` method — `{"config": {...}}` arms, `{"config": null}`
//      resets; the reply is `{"faults": {...}}`. `mock.faults` is intentionally NOT part of the
//      `methods` reply, which stays byte-identical to the vendor list.

/**
 * @typedef {Object} FaultConfig
 * @property {string|null} [crashOnCommand]
 *   An engine command id (`engine.execute`/batch dispatch kills the process with exit code 1
 *   when this command runs, before any reply — the client sees the connection drop).
 * @property {string|null} [hangOnMethod]
 *   A control method id whose reply is never written (the connection stays open until the
 *   30 s idle timeout drops it — the client must hit its own request timeout).
 * @property {string|null} [oversizedReply]
 *   A control method id whose result is padded past the 8 MiB reply ceiling, so the transport
 *   answers with the vendor's reply-budget error ("response exceeds …; operation may have
 *   completed" — studio typed name `frame_too_large`).
 */

const CONFIG_KEYS = new Set(["crashOnCommand", "hangOnMethod", "oversizedReply"]);

/** Parse and validate a fault configuration object. Returns a frozen plain object. */
export function parseFaultConfig(value) {
  if (value === null || value === undefined) return Object.freeze({});
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch (error) {
      throw new Error(`MOCK_ENGINE_FAULTS is not valid JSON: ${error.message}`);
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("MOCK_ENGINE_FAULTS must be a JSON object");
  }
  /** @type {Record<string, string|null>} */
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!CONFIG_KEYS.has(key)) continue; // unknown keys ignored, forward-compatible
    if (entry === null || entry === undefined) continue;
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error(`MOCK_ENGINE_FAULTS: ${key} must be a non-empty string or null`);
    }
    out[key] = entry;
  }
  return Object.freeze(out);
}

/**
 * Mutable holder for the active fault configuration; the transport consults it on every
 * request so tests can arm faults through `mock.faults` while the server is running.
 */
export class FaultHooks {
  /** @param {FaultConfig} config */
  constructor(config = {}) {
    this.config = parseFaultConfig(config);
  }

  /** @param {FaultConfig|null} config */
  set(config) {
    this.config = parseFaultConfig(config);
    return this.config;
  }

  /** @param {string} commandId */
  crashOn(commandId) {
    return this.config.crashOnCommand === commandId;
  }

  /** @param {string} methodId */
  hangs(methodId) {
    return this.config.hangOnMethod === methodId;
  }

  /** @param {string} methodId */
  oversizes(methodId) {
    return this.config.oversizedReply === methodId;
  }
}
