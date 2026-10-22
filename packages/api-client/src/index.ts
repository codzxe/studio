// @studio/api-client — barrel (named exports only).
//
// The typed browser+node client for the Studio control plane (§7.2):
//   * client.ts       — createApiClient + namespaced route methods
//   * api-error.ts    — ApiError + fromResponse/isApiError
//   * sse.ts          — streamChat: AI-SDK/Studio SSE reader + reconnect
//   * response-schemas.ts — Zod mirrors of the contracts response interfaces
//   * fixtures.ts     — deterministic dev/demo dataset (validateFixtures)

export * from "./api-error";
export * from "./client";
export * from "./response-schemas";
export * from "./sse";
export * from "./fixtures";
