// tests/contract.test.ts — §21 Contract-testing row: "Recorded RPC fixtures + schema tests.
// The control protocol client against frozen responses; detect upstream drift in CI."
//
// Three layers, in order:
//   1. Fixture pins — every recorded-style reply in fixtures/replies parses against the
//      Zod schemas transcribed from vendor/photocraft rpc.rs / security.rs / inspect.rs
//      (protocol-schemas.ts). Upstream wire drift breaks these first.
//   2. Transport driving — JsonLinesTransport (tests/reference-transport.ts) replays the
//      fixtures through FakeSocket: parsing, correlation, error paths, budget enforcement.
//      NOTE (W2-E task fallback): src/index.ts is owned by W2-D and was absent at
//      authoring time, so this file drives the transport+methods layers directly; the
//      reference transport is the executable protocol spec until then.
//   3. Real client — once src/index.ts exists, the same fixtures + FakeSocket drive the
//      real EngineClient (auto-detected; the block skips while src is missing and fails
//      loudly if the seam drifts — reconcile here and in one place).
//
// Cross-package budget pins: @studio/config mirrors the engine's automation budgets
// (limits.ts cites crates/automation/src/budgets.rs); this file asserts they still agree.

import { describe, expect, it } from "vitest";
import {
  ENGINE_PNG_MAX_BYTES,
  ENGINE_PREVIEW_MAX_PX,
  ENGINE_REPLY_MAX_BYTES,
} from "@studio/config";
import { FakeSocket } from "./fake-socket.js";
import {
  MAX_BATCH_STEPS,
  MAX_REPLY_BYTES,
  MAX_REQUEST_BYTES,
  METHODS_PIN,
  OVERSIZED_REQUEST_ERROR,
  REQUIRED_METHODS,
  authOkSchema,
  batchResultSchema,
  commandListResultSchema,
  correlationIdSchema,
  docInspectResultSchema,
  docNewResultSchema,
  docNewResultSchema as _docNewUnused, // biome organizes imports; keep single import instead
} from "./protocol-schemas.js";
