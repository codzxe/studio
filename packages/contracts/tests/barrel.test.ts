import { describe, expect, it } from "vitest";

import * as contracts from "../src/index.js";
import type { MeResponse, ProjectManifest } from "../src/index.js";

/** Everything downstream services import must exist on the barrel. */
const REQUIRED_EXPORTS: readonly string[] = [
  // envelope (§7.3)
  "ok",
  "err",
  "okSchema",
  "isEnvelope",
  "isOk",
  "isErr",
  "WIRE_ERROR_CODES",
  "ERR_SCHEMA",
  // engine.batch (§8.5)
  "AGENT_BATCH_SCHEMA",
  "BATCH_STEP_SCHEMA",
  "collectRefs",
  "validateBatchRefs",
  "checkBatchCommands",
  "MAX_BATCH_STEPS",
  "MAX_BATCH_BYTES",
  "MAX_BATCH_TIMEOUT_MS",
  // edit plan (§8.6)
  "EDIT_PLAN_SCHEMA",
  "PLAN_INTENT_SCHEMA",
  "PLAN_RISK_SCHEMA",
  "estimateCredits",
  "reserveFor",
  "isAutoApplicable",
  "isRiskAtLeast",
  "needsConfirmCheckbox",
  // events (§7.4)
  "STUDIO_STREAM_EVENT_SCHEMA",
  "STUDIO_STREAM_EVENT_TYPES",
  "INITIAL_RUN_STATE",
  "applyEvents",
  "reduceEvents",
  "isStudioStreamEvent",
  "RUN_STATUSES",
  // tools (§8.4)
  "TOOL_IDS",
  "TOOL_CATALOG",
  "TOOL_LIST",
  "getTool",
  "isWriteTool",
  // models (§8.2/§10.1)
  "MODEL_IDS",
  "MODEL_CATALOG",
  "PLAN_IDS",
  "PLAN_MODEL_ENTITLEMENTS",
  "modelAllowedForPlan",
  "allowedModelsForPlan",
  // routes (§7.2)
  "CREATE_WORKSPACE_SCHEMA",
  "PATCH_WORKSPACE_SCHEMA",
  "INVITE_MEMBER_SCHEMA",
  "CREATE_PROJECT_SCHEMA",
  "PATCH_PROJECT_SCHEMA",
  "UPLOAD_VERSION_SCHEMA",
  "RESTORE_VERSION_SCHEMA",
  "ACQUIRE_LEASE_SCHEMA",
  "CREATE_ASSET_SCHEMA",
  "CREATE_THREAD_SCHEMA",
  "CHAT_REQUEST_SCHEMA",
  "CONTEXT_SELECTION_SCHEMA",
  "PINNED_CONTEXT_ITEM_SCHEMA",
  "PAGINATION_QUERY_SCHEMA",
  "RUN_EVENT_REQUEST_SCHEMA",
  "CANCEL_RUN_SCHEMA",
  "LEDGER_KIND_SCHEMA",
  "CHECKOUT_SCHEMA",
  "PORTAL_SCHEMA",
  "QUEUE_RENDER_SCHEMA",
  "CREATE_COMMENT_SCHEMA",
  "RESOLVE_COMMENT_SCHEMA",
  "ACTIVITY_QUERY_SCHEMA",
  "ROLE_SCHEMA",
  "SHA256_SCHEMA",
  "ID_SCHEMA",
  "IDEMPOTENCY_KEY_SCHEMA",
  // W5-09 gap fill: settings + workspace audit + reconcile wires.
  "SETTINGS_RESPONSE_SCHEMA",
  "SETTINGS_PATCH_SCHEMA",
  "AUDIT_QUERY_SCHEMA",
  "AUDIT_ENTRY_SCHEMA",
  "RECONCILE_REQUEST_SCHEMA",
] as const;

describe("barrel: @studio/contracts public surface", () => {
  it("exports every required contract name", () => {
    for (const name of REQUIRED_EXPORTS.filter((n) => n !== "")) {
      expect(contracts, `missing export: ${name}`).toHaveProperty(name);
    }
  });

  it("exports only named members (no default export)", () => {
    expect((contracts as { default?: unknown }).default).toBeUndefined();
  });

  it("route response types are type-only but importable as types", () => {
    const manifest: ProjectManifest = {
      projectId: "p",
      currentVersion: null,
      assets: [],
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const me: MeResponse = {
      user: { id: "u", name: null, email: "a@b.co" },
      memberships: [],
      plan: { plan: "starter", creditsBalance: 900, includedCredits: 1000, renewsAt: null },
    };
    expect(manifest.currentVersion).toBeNull();
    expect(me.plan.plan).toBe("starter");
  });
});
