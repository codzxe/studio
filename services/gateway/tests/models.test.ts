// M4-A2 — GET /v1/models (§8.2/§10.1) with STUB deps (no Postgres): the
// model-entitlement read behind the chat model picker. Pins the exact wire
// shape the wave-2 picker consumes — Ok<{ plan, models: [{ id, tier, use,
// creditsPer1kInput, creditsPer1kOutput }] }> — and that trial entitlements
// filter out smart/vision while `allowedPlans` never reaches the browser.

import { beforeEach, describe, expect, it } from "vitest";

import type { Hono } from "hono";

import { MODELS_RESPONSE_SCHEMA } from "@studio/contracts";

import { buildApp } from "../src/app.js";
import type { AppBindings } from "../src/context.js";
import { FakeGatewayAuth, stubDeps, testEnv } from "./helpers.js";

const env = testEnv();

let auth: FakeGatewayAuth;
let app: Hono<AppBindings>;

beforeEach(() => {
  auth = new FakeGatewayAuth();
  const deps = stubDeps(env, { auth });
  app = buildApp({ deps });
});

/** §7.3 Ok envelope: parses the body and returns the `data` arm. */
async function okData(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json()) as Record<string, unknown>;
  expect(body).toHaveProperty("data");
  return body.data as Record<string, unknown>;
}

describe("GET /v1/models", () => {
  it("a viewer can list the workspace's entitled models (200 Ok envelope)", async () => {
    const { user, org } = auth.signUp("viewer");
    const response = await app.request("/v1/models", {
      headers: { cookie: `w3gw=${user.token}`, "x-workspace-id": org.id },
    });
    expect(response.status).toBe(200);
    const data = await okData(response);
    expect(data.plan).toBe("trial");
    expect(Array.isArray(data.models)).toBe(true);
  });

  it("unauthenticated → 401 with the exact AUTH_REQUIRED envelope (§7.3, §8.9)", async () => {
    const response = await app.request("/v1/models");
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error).toEqual({
      code: "AUTH_REQUIRED",
      message: "Sign in to continue.",
      hint: "Your session may have expired.",
      retryable: false,
      requestId: expect.stringMatching(/^req_[0-9a-f]{32}$/),
    });
  });

  it("unknown workspace → 404 WORKSPACE_NOT_FOUND (cross-tenant reads as NOT_FOUND, §12.1)", async () => {
    const { user } = auth.signUp();
    const response = await app.request("/v1/models", {
      headers: { cookie: `w3gw=${user.token}`, "x-workspace-id": "totally-unknown-workspace" },
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("trial entitlements filter out smart/vision: exactly [studio-fast] (§8.2 Plan gating)", async () => {
    const { user, org } = auth.signUp("viewer");
    const response = await app.request("/v1/models", {
      headers: { cookie: `w3gw=${user.token}`, "x-workspace-id": org.id },
    });
    const data = await okData(response);
    const models = data.models as { id: string }[];
    expect(models.map((model) => model.id)).toEqual(["studio-fast"]);
  });

  it("descriptors carry the wire fields exactly — no allowedPlans key leaks (§8.2)", async () => {
    const { user, org } = auth.signUp("viewer");
    const response = await app.request("/v1/models", {
      headers: { cookie: `w3gw=${user.token}`, "x-workspace-id": org.id },
    });
    const data = await okData(response);
    const models = data.models as Record<string, unknown>[];
    expect(models).toHaveLength(1);
    expect(models[0]).toEqual({
      id: "studio-fast",
      tier: "fast",
      use: "Cheap planning, classification, quick edits",
      creditsPer1kInput: 0.01,
      creditsPer1kOutput: 0.03,
    });
    expect(JSON.stringify(data)).not.toContain("allowedPlans");
  });

  it("the route's real payload parses through MODELS_RESPONSE_SCHEMA (the api-client runtime validator's contracts twin)", async () => {
    // The api-client's own MODELS_RESPONSE_SCHEMA is `satisfies`-pinned to the
    // same contracts ModelsResponse type (drift fails ITS typecheck), so
    // parsing the live route payload through the wire schema here proves the
    // client-side validation accepts the gateway's bytes.
    const { user, org } = auth.signUp("viewer");
    const response = await app.request("/v1/models", {
      headers: { cookie: `w3gw=${user.token}`, "x-workspace-id": org.id },
    });
    const data = await okData(response);
    const parsed = MODELS_RESPONSE_SCHEMA.safeParse(data);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual(data);
    }
  });
});
