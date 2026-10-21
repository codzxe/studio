// Test fakes: a fully-typed in-memory ToolContext (§6) — no engine, no db, no clock.

import type { EngineOutcome, ToolContext } from "../src/types.js";

const success = <T>(value: T): EngineOutcome<T> => ({ ok: true, value });

/** A fresh, never-aborted signal (§3.4 tool deadline seam). */
export function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

/** An already-aborted signal, as the executor hands over when the run deadline passed. */
export function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

/** Deterministic ToolContext satisfying every seam in src/types.ts. */
export function makeFakeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    engine: {
      batch: async () => success({ revision: 1, outcomes: [] }),
      execute: async () => success({ revision: 1 }),
      render: async () => success({ image: new Uint8Array(), widthPx: 64, heightPx: 64 }),
      inspect: async () => success({ revision: 1, widthPx: 800, heightPx: 600, layers: [] }),
      listLayers: async () => success([]),
    },
    db: {
      getDocument: async () => undefined,
      appendCommandLog: async () => undefined,
    },
    templates: {
      get: async () => undefined,
      list: async () => [],
    },
    assets: {
      search: async () => [],
      get: async () => undefined,
    },
    budgets: {
      remaining: () => ({ msRemaining: 5000, commandsRemaining: 256 }),
      charge: () => true,
    },
    workspace: {
      organizationId: "org_00000000-0000-0000-0000-000000000000",
      brandTokens: { palette: { primary: "#FF00AA" }, fonts: ["Inter"] },
    },
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}
