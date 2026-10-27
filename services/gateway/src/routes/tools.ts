// @studio/gateway — POST /v1/threads/:id/tools/{web_search,generate_image}
// (round 12, client-driven agent loop — design §"Tool catalog v3" + the
// TURN WIRE CONTRACT tail): the two SERVER-executed generative tool seams.
// The browser runs the agent loop and executes read/generative tools locally;
// `studio.web_search` and `studio.generate_image` are the two that need a
// server-side provider (the key must never ship to the client), so the client
// POSTs them here mid-run and echoes the JSON result into the next turn.
//
// Metering (§8.8): web_search = exactly 1 credit, generate_image = exactly 8,
// charged through the SAME credit_ledger repo seam chat runs use
// (deps.repos.ledger), converted to integer microcredits at the boundary
// (D-12 — credits-display.ts). Tool calls have no run row (the round-12 loop
// is client-owned, so there is no producer scope to hold against), so the
// charge is an UNSCOPED negative `adjust` — the repo's only unscoped mutator
// besides grant. The idempotency-key path mirrors the other metered routes
// (`chat:${runId}:reserve`, `render:reserve:${render.id}`): the request's own
// Idempotency-Key header (required on POST /v1 mutations by the middleware)
// is namespaced per tool — `tool:${tool}:${header}` — and the ledger's unique
// idempotency index makes a double-charge impossible even if the in-memory
// replay store dies with the isolate.
//
// Failure posture (law #1): network errors, provider non-2xx/429s and
// malformed provider bodies NEVER leak upstream details — the caller gets
// the typed retryable WEB_SEARCH_UNAVAILABLE / IMAGE_GENERATION_UNAVAILABLE
// envelope (503) and is never charged. An unconfigured image provider is NOT
// an error of the same family: it is a permanent, non-retryable 501 the model
// can explain honestly ("not configured for this deployment").

import { Hono } from "hono";
import { z } from "zod";

import { StudioError } from "@studio/config";

import type { AppBindings, AppContext, GatewayDeps } from "../context.js";
import { creditsToLedgerMicrocredits } from "../credits-display.js";
import { GatewayError } from "../errors.js";
import { ok, pathParam } from "../http.js";
import { requireAuth, requireWorkspace } from "../middleware.js";

// ---------------------------------------------------------------------------
// Request schemas (local — contracts ownership stays with agent i2 this round)
// ---------------------------------------------------------------------------

const WEB_SEARCH_REQUEST_SCHEMA = z.object({
  query: z.string().min(1).max(400),
  maxResults: z
    .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)])
    .default(5),
});

const IMAGE_REQUEST_SCHEMA = z.object({
  prompt: z.string().min(1).max(2000),
  size: z.enum(["1024x1024", "1536x1024", "1024x1536"]).default("1024x1024"),
});

// ---------------------------------------------------------------------------
// Provider constants (round-12 design pins: keyless Tavily default, 5 results
// trimmed to 500 chars; OpenAI-compatible images endpoint behind env)
// ---------------------------------------------------------------------------

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const TAVILY_TIMEOUT_MS = 15_000;
const TAVILY_CONTENT_MAX_CHARS = 500;
const IMAGE_TIMEOUT_MS = 30_000;
const IMAGE_RESPONSE_MAX_BYTES = 10 * 1024 * 1024;

/** optional env — not in the strict schema (round 12) */
function tavilyApiKey(): string | undefined {
  const key = process.env.TAVILY_API_KEY;
  return typeof key === "string" && key.length > 0 ? key : undefined;
}

/** optional env — not in the strict schema (round 12) */
function imageProviderConfig(): { baseUrl: string; apiKey: string; model: string } | null {
  const baseUrl = process.env.STUDIO_IMAGE_API_BASE_URL;
  const apiKey = process.env.STUDIO_IMAGE_API_KEY;
  const model = process.env.STUDIO_IMAGE_API_MODEL;
  if (typeof baseUrl !== "string" || baseUrl === "") return null;
  if (typeof apiKey !== "string" || apiKey === "") return null;
  if (typeof model !== "string" || model === "") return null;
  return { baseUrl, apiKey, model };
}

// ---------------------------------------------------------------------------
// Metering (§8.8) — same ledger seam as chat runs, microcredits at the boundary
// ---------------------------------------------------------------------------

/**
 * §8.8 precheck (chat.ts pattern): the balance read happens BEFORE anything —
 * a workspace that cannot cover the flat cost never triggers the provider
 * call. The ledger is integer µc (D-12 — credits-display.ts).
 */
async function assertToolCredits(input: {
  readonly deps: GatewayDeps;
  readonly workspaceId: string;
  readonly requestId: string;
  readonly credits: number;
}): Promise<void> {
  const balance = await input.deps.repos.ledger.balance(input.workspaceId);
  if (balance < creditsToLedgerMicrocredits(input.credits)) {
    throw new StudioError("INSUFFICIENT_CREDITS", { requestId: input.requestId });
  }
}

/**
 * The commit half — an UNSCOPED negative `adjust` through the same
 * deps.repos.ledger seam (tools have no run row; adjust is the repo's only
 * unscoped mutator besides grant). Runs only after a successful provider
 * response, so failures never charge. Idempotency path mirrors the other
 * metered routes (`chat:${runId}:reserve`, `render:reserve:${render.id}`):
 * the request's own Idempotency-Key header namespaced per tool.
 */
async function chargeToolCredits(input: {
  readonly deps: GatewayDeps;
  readonly workspaceId: string;
  readonly requestId: string;
  readonly idempotencyHeader: string | undefined;
  readonly tool: "web_search" | "generate_image";
  readonly credits: number;
  readonly threadId: string;
}): Promise<void> {
  const anchor = input.idempotencyHeader ?? input.requestId;
  await input.deps.repos.ledger.adjust(input.workspaceId, {
    amount: -creditsToLedgerMicrocredits(input.credits),
    idempotencyKey: `tool:${input.tool}:${anchor}`,
    metadata: { tool: input.tool, threadId: input.threadId, credits: input.credits },
  });
}

// ---------------------------------------------------------------------------
// Typed failure envelopes (law #1: never echo provider errors)
// ---------------------------------------------------------------------------

function webSearchUnavailable(requestId: string): GatewayError {
  return new GatewayError("WEB_SEARCH_UNAVAILABLE", "Web search isn't available right now.", {
    status: 503,
    hint: "Try again in a moment.",
    retryable: true,
    requestId,
  });
}

function imageGenerationUnavailable(requestId: string): GatewayError {
  return new GatewayError(
    "IMAGE_GENERATION_UNAVAILABLE",
    "Image generation isn't available right now.",
    {
      status: 503,
      hint: "Try again in a moment.",
      retryable: true,
      requestId,
    },
  );
}

function providerDetail(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : "unknown";
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerToolRoutes(deps: GatewayDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("/v1/threads/*", requireAuth());

  // -- POST /v1/threads/:id/tools/web_search — Tavily, metered 1 credit ----
  app.post(
    "/v1/threads/:id/tools/web_search",
    requireWorkspace("editor"),
    async (c: AppContext): Promise<Response> => {
      const requestId = c.get("requestId");
      const workspace = c.get("workspace");
      const threadId = pathParam(c, "id");

      const parsed = WEB_SEARCH_REQUEST_SCHEMA.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        throw new StudioError("VALIDATION_FAILED", { requestId });
      }
      const request = parsed.data;

      // Thread must live in this workspace (repo: cross-tenant reads as 404).
      await deps.repos.threads.get(workspace.id, threadId);

      // §8.8: the balance gate comes BEFORE the provider call (chat.ts's
      // "never start on a zero balance" ordering — no free search side effects).
      await assertToolCredits({ deps, workspaceId: workspace.id, requestId, credits: 1 });

      // Keyless by default; TAVILY_API_KEY (optional) switches to Bearer auth.
      const key = tavilyApiKey();
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (key === undefined) {
        headers["x-tavily-access-mode"] = "keyless";
      } else {
        headers.authorization = `Bearer ${key}`;
      }

      let response: Response;
      try {
        response = await fetch(TAVILY_SEARCH_URL, {
          method: "POST",
          headers,
          body: JSON.stringify({
            query: request.query,
            max_results: request.maxResults,
            search_depth: "basic",
          }),
          signal: AbortSignal.timeout(TAVILY_TIMEOUT_MS),
        });
      } catch (error) {
        deps.logger.warn("tool_web_search_failed", {
          requestId,
          threadId,
          detail: providerDetail(error),
        });
        throw webSearchUnavailable(requestId);
      }
      if (!response.ok) {
        deps.logger.warn("tool_web_search_failed", {
          requestId,
          threadId,
          detail: `tavily status ${response.status}`,
        });
        throw webSearchUnavailable(requestId);
      }

      const body = (await response.json().catch(() => null)) as {
        results?: readonly { title?: unknown; url?: unknown; content?: unknown }[];
      } | null;
      if (body === null || !Array.isArray(body.results)) {
        deps.logger.warn("tool_web_search_failed", {
          requestId,
          threadId,
          detail: "malformed provider body",
        });
        throw webSearchUnavailable(requestId);
      }
      const results = body.results.map((row) => ({
        title: typeof row?.title === "string" ? row.title : "",
        url: typeof row?.url === "string" ? row.url : "",
        content:
          typeof row?.content === "string" ? row.content.slice(0, TAVILY_CONTENT_MAX_CHARS) : "",
      }));

      // Charged only on a successful, mappable provider response.
      await chargeToolCredits({
        deps,
        workspaceId: workspace.id,
        requestId,
        idempotencyHeader: c.req.header("idempotency-key") ?? c.req.header("x-idempotency-key"),
        tool: "web_search",
        credits: 1,
        threadId,
      });
      return ok(c, { results });
    },
  );

  // -- POST /v1/threads/:id/tools/generate_image — metered 8 credits -------
  app.post(
    "/v1/threads/:id/tools/generate_image",
    requireWorkspace("editor"),
    async (c: AppContext): Promise<Response> => {
      const requestId = c.get("requestId");
      const workspace = c.get("workspace");
      const threadId = pathParam(c, "id");

      const parsed = IMAGE_REQUEST_SCHEMA.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        throw new StudioError("VALIDATION_FAILED", { requestId });
      }
      const request = parsed.data;

      // Thread must live in this workspace (repo: cross-tenant reads as 404).
      await deps.repos.threads.get(workspace.id, threadId);

      // §8.8: the balance gate comes BEFORE the provider call.
      await assertToolCredits({ deps, workspaceId: workspace.id, requestId, credits: 8 });

      const provider = imageProviderConfig();
      if (provider === null) {
        // Honest, non-retryable: the deployment has no image backend wired.
        throw new GatewayError(
          "IMAGE_GENERATION_UNAVAILABLE",
          "Image generation is not configured for this workspace's deployment.",
          {
            status: 501,
            retryable: false,
            requestId,
          },
        );
      }

      let response: Response;
      try {
        response = await fetch(`${provider.baseUrl.replace(/\/+$/, "")}/images/generations`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${provider.apiKey}`,
          },
          body: JSON.stringify({
            model: provider.model,
            prompt: request.prompt,
            size: request.size,
            n: 1,
          }),
          signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
        });
      } catch (error) {
        deps.logger.warn("tool_image_failed", {
          requestId,
          threadId,
          detail: providerDetail(error),
        });
        throw imageGenerationUnavailable(requestId);
      }
      if (!response.ok) {
        deps.logger.warn("tool_image_failed", {
          requestId,
          threadId,
          detail: `provider status ${response.status}`,
        });
        throw imageGenerationUnavailable(requestId);
      }

      const raw = await response.text();
      if (Buffer.byteLength(raw) > IMAGE_RESPONSE_MAX_BYTES) {
        deps.logger.warn("tool_image_failed", {
          requestId,
          threadId,
          detail: "provider body exceeded 10MB",
        });
        throw imageGenerationUnavailable(requestId);
      }

      let body: { data?: readonly { b64_json?: unknown; url?: unknown }[] } | null = null;
      try {
        body = JSON.parse(raw) as {
          data?: readonly { b64_json?: unknown; url?: unknown }[];
        } | null;
      } catch {
        body = null; // malformed provider JSON → the typed unavailable envelope
      }
      const image: { imageBase64?: string; imageUrl?: string } = {};
      if (body !== null && Array.isArray(body.data)) {
        for (const item of body.data) {
          if (typeof item?.b64_json === "string" && item.b64_json.length > 0) {
            image.imageBase64 = item.b64_json;
            break;
          }
          if (typeof item?.url === "string" && item.url.length > 0) {
            image.imageUrl = item.url;
            break;
          }
        }
      }
      if (image.imageBase64 === undefined && image.imageUrl === undefined) {
        deps.logger.warn("tool_image_failed", {
          requestId,
          threadId,
          detail: "provider body carried no image",
        });
        throw imageGenerationUnavailable(requestId);
      }

      // Charged only on a successful, mappable provider response.
      await chargeToolCredits({
        deps,
        workspaceId: workspace.id,
        requestId,
        idempotencyHeader: c.req.header("idempotency-key") ?? c.req.header("x-idempotency-key"),
        tool: "generate_image",
        credits: 8,
        threadId,
      });
      return ok(c, image);
    },
  );

  return app;
}
