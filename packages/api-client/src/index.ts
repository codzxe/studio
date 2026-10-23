// @studio/api-client — barrel (named exports only).
//
// The typed browser+node client for the Studio control plane (§7.2):
//   * client.ts       — createApiClient + namespaced route methods
//   * api-error.ts    — ApiError + fromResponse/isApiError
//   * sse.ts          — streamChat: AI-SDK/Studio SSE reader + reconnect
//   * response-schemas.ts — Zod mirrors of the contracts response interfaces
//
// NOT on this entry (W2-B3, mirroring editor-bridge's `./fake` seam): the
// 2,000-line deterministic demo dataset lives behind the `./fixtures`
// SUBPATH export only (`import { fixtures } from "@studio/api-client/fixtures"`)
// so production code/bundles can never pull demo data off the main barrel.
// `./chat-tools` is subpath-only for the same reason (bundle hygiene).

export * from "./api-error";
export * from "./client";
export * from "./response-schemas";
export * from "./sse";
