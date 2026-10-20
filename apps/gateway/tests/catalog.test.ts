// Catalog routes + service tests (W4-J) — deterministic, no network, no DB
// (AGENTS.md test rules). The service tests load the REAL seed manifests from
// `evals/templates` + `evals/components` through the production repo-relative
// resolution, so the loader, the §7.2/§8.2 Zod validation and the list/inspect
// semantics are exercised against the committed catalog data (§7.4: 3 seed
// templates — grows to 10 by beta — + the §8.3 ten-component start library).
// Workspace registration runs over an in-memory WorkspaceTemplatesStore fake
// through buildApp's full middleware stack (error mapper, request id, logger).

import { afterEach, describe, expect, it } from "vitest";
import pino from "pino";
import { err, ok, type Result } from "@studio/config";
import type { WorkspaceTemplate } from "@studio/db";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import { gatewayTransportSchema } from "../src/env.js";
import { mountCatalogRoutes } from "../src/routes/catalog.js";
import { InMemoryKV, RateLimiter } from "../src/services/limiter.js";
import {
  CatalogBootError,
  TemplateCatalog,
  formatPins,
  queryMatches,
  tagsMatchAll,
  workspaceTemplateId,
  type CatalogAuthLike,
  type CatalogCaller,
  type CatalogResult,
  type CatalogDeps,
  type WorkspaceTemplatesStore,
} from "../src/services/catalog.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG_A = "org-a";
const ORG_B = "org-b";
const TOKEN_ADMIN_A = "token-admin-a";
const TOKEN_OWNER_A = "token-owner-a";
const TOKEN_EDITOR_A = "token-editor-a";
const TOKEN_VIEWER_A = "token-viewer-a";
const TOKEN_ADMIN_B = "token-admin-b";
const USER_A = "user-a";
const USER_B = "user-b";

const FIXED_NOW_MS = Date.parse("2026-01-15T10:00:00.000Z");

/** §7.4: the three seed templates (the catalog grows to 10 by beta). */
const SEED_TEMPLATE_PINS = [
  "instagram-post@3",
  "presentation-slide@1",
  "youtube-thumbnail@1",
] as const;

/** §8.3: the ten hard-coded start components. */
const SEED_COMPONENT_PINS = [
  "avatar-circle@1",
  "button-cta@1",
  "logo-lockup@1",
  "offer-badge@2",
  "price-tag@1",
  "quote-block@1",
  "ribbon-banner@1",
  "social-handle@1",
  "star-rating@1",
  "wave-divider@1",
] as const;

class FakeAuth implements CatalogAuthLike {
  constructor(private readonly callers: ReadonlyMap<string, CatalogCaller>) {}

  async authenticate(request: Request): Promise<Result<CatalogCaller>> {
    const header = request.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    const caller = this.callers.get(token);
    if (caller === undefined) {
      return err("unauthorized", "Missing or invalid credentials.", {
        hint: "Send Authorization: Bearer <token>.",
        retryable: false,
      });
    }
    return ok(caller);
  }
}

/** In-memory workspace_templates store (mirrors the deterministic-row contract). */
class FakeStore implements WorkspaceTemplatesStore {
  readonly rows: WorkspaceTemplate[] = [];
  failNextInsert = false;

  async findWorkspaceTemplate(
    organizationId: string,
    templateId: string,
    version: number,
  ): Promise<WorkspaceTemplate | null> {
    const found = this.rows.find((row) => {
      return (
        row.organizationId === organizationId &&
        row.manifest.id === templateId &&
        row.version === version
      );
    });
    return found ?? null;
  }

  async insertWorkspaceTemplate(input: {
    readonly id: string;
    readonly organizationId: string;
    readonly source: "public" | "workspace";
    readonly manifest: Record<string, unknown>;
    readonly version: number;
  }): Promise<WorkspaceTemplate> {
    if (this.failNextInsert) {
      this.failNextInsert = false;
      throw new Error("fake store: insert failed");
    }
    const existing = this.rows.find((row) => row.id === input.id);
    if (existing !== undefined) {
      return existing; // mirrors onConflictDoNothing + re-read
    }
    const row: WorkspaceTemplate = {
      id: input.id,
      organizationId: input.organizationId,
      source: input.source,
      manifest: input.manifest,
      version: input.version,
      createdAt: new Date(FIXED_NOW_MS),
    };
    this.rows.push(row);
    return row;
  }
}

interface Harness {
  readonly catalog: TemplateCatalog;
  readonly store: FakeStore;
  readonly app: ReturnType<typeof buildApp>;
}

function makeAuth(): FakeAuth {
  return new FakeAuth(
    new Map<string, CatalogCaller>([
      [TOKEN_ADMIN_A, { userId: USER_A, organizationId: ORG_A, role: "admin" }],
      [TOKEN_OWNER_A, { userId: USER_A, organizationId: ORG_A, role: "owner" }],
      [TOKEN_EDITOR_A, { userId: USER_A, organizationId: ORG_A, role: "editor" }],
      [TOKEN_VIEWER_A, { userId: USER_A, organizationId: ORG_A, role: "viewer" }],
      [TOKEN_ADMIN_B, { userId: USER_B, organizationId: ORG_B, role: "admin" }],
    ]),
  );
}

function makeHarness(
  options: {
    readonly rateLimit?: { readonly limit: number; readonly windowSec: number };
    readonly limiter?: RateLimiter;
  } = {},
): Harness {
  const catalog = TemplateCatalog.load();
  const store = new FakeStore();
  const deps: CatalogDeps = {
    auth: makeAuth(),
    catalog,
    store,
    ...(options.limiter !== undefined ? { limiter: options.limiter } : {}),
    logger: pino({ enabled: false }),
  };
  const app = buildApp({
    env: gatewayTransportSchema.parse({}),
    logger: pino({ enabled: false }),
    version: "0.0.0-test",
    probes: [],
    startedAt: FIXED_NOW_MS,
    mount: (root) => {
      mountCatalogRoutes(root, deps, {
        ...(options.rateLimit !== undefined ? { rateLimit: options.rateLimit } : {}),
      });
    },
  });
  return { catalog, store, app };
}

function jsonHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json", ...extra };
}

async function get(
  harness: Harness,
  path: string,
  options: { readonly token?: string } = {},
): Promise<Response> {
  const token = options.token ?? TOKEN_ADMIN_A;
  return harness.app.request(path, { headers: jsonHeaders(token) });
}

async function post(
  harness: Harness,
  path: string,
  body: unknown,
  options: {
    readonly token?: string;
    readonly idempotencyKey?: string;
    readonly omitIdempotencyKey?: boolean;
  } = {},
): Promise<Response> {
  const token = options.token ?? TOKEN_ADMIN_A;
  const headers = jsonHeaders(token);
  if (!options.omitIdempotencyKey) {
    headers["Idempotency-Key"] = options.idempotencyKey ?? "idem-catalog-1";
  }
  return harness.app.request(path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

/** Unwraps a CatalogResult; throws (fails the test) on a failure envelope. */
function expectOk<T>(result: CatalogResult<T>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.code}: ${result.message}`);
  }
  return result.value;
}

interface Card {
  readonly id: string;
  readonly version: number;
  readonly ref: string;
  readonly name: string;
  readonly tags: string[];
  readonly canvas?: { readonly width: number; readonly height: number };
  readonly slots?: string[];
  readonly defaultSize?: { readonly width: number; readonly height: number };
  readonly license?: string;
  readonly variables?: string[];
  readonly comps?: string[];
}

interface Envelope {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly hint?: string;
  readonly retryable: boolean;
}

async function errorEnvelope(res: Response): Promise<Envelope> {
  const body = (await res.json()) as Envelope;
  expect(body.ok).toBe(false);
  return body;
}

/** A full §7.2 manifest for the workspace-registration tests. */
const REGISTRATION_MANIFEST: Record<string, unknown> = {
  id: "spring-sale-post",
  version: 1,
  name: "Spring Sale Post",
  description: "A promo post with a photo, headline and component badge.",
  tags: ["social", "promo", "square"],
  canvas: { width: 1080, height: 1080, background: "#F4E7D3" },
  slots: {
    photo: {
      kind: "image",
      layer: "Photo",
      bounds: [0, 0, 1080, 700],
      fit: "cover",
      minPixels: [1080, 700],
      optional: false,
    },
    headline: {
      kind: "text",
      layer: "Headline",
      bounds: [72, 732, 936, 176],
      font: "display",
      weight: "bold",
      size: 96,
      maxLines: 2,
      maxChars: 42,
      align: "left",
      color: "#3B2A20",
      autoFit: { minSize: 56, maxSize: 110 },
    },
    badge: {
      kind: "component",
      component: "offer-badge@2",
      layer: "Badge",
      bounds: [828, 72, 180, 180],
      optional: true,
      vars: { label: "20% OFF" },
    },
  },
  rules: {
    safeArea: 48,
    minContrast: 4.5,
    mustLayers: ["Background", "Photo", "Headline"],
    maxTextLayers: 6,
    palette: ["#F4E7D3", "#3B2A20", "#D96C3B"],
  },
  layerMap: {
    Background: { role: "background", fill: "#F4E7D3" },
    Photo: { role: "image" },
    Headline: { role: "headline" },
    Badge: { role: "component", component: "offer-badge@2" },
  },
  thumbnail: "thumbnails/spring-sale-post@1.png",
  author: "test",
};

// ---------------------------------------------------------------------------
// Service: the REAL seed catalog loads (§7.4 three templates, §8.3 ten components)
// ---------------------------------------------------------------------------

describe("TemplateCatalog.load — real seed manifests", () => {
  it("loads the three §7.4 seed templates (grows to 10 by beta)", () => {
    const catalog = TemplateCatalog.load();
    const pins = catalog.templatePins();
    for (const pin of SEED_TEMPLATE_PINS) {
      expect(pins).toContain(pin);
    }
    expect(catalog.templateCount).toBeGreaterThanOrEqual(SEED_TEMPLATE_PINS.length);
  });

  it("loads the ten §8.3 start components with pinned versions", () => {
    const catalog = TemplateCatalog.load();
    const pins = catalog.componentPins();
    for (const pin of SEED_COMPONENT_PINS) {
      expect(pins).toContain(pin);
    }
    expect(pins).toContain("offer-badge@2"); // the §7.2 example ships at version 2
  });

  it("serves the full §7.2 manifest verbatim (raw document, not stripped)", () => {
    const catalog = TemplateCatalog.load();
    const manifest = expectOk(catalog.inspect("instagram-post", 3));
    expect(manifest.id).toBe("instagram-post");
    expect(manifest.version).toBe(3);
    expect(manifest.name).toBe("Instagram Post — Promo");
    expect(manifest.license).toBe("public");
    expect(manifest.slots?.headline?.layer).toBe("Headline");
    expect(manifest.slots?.badge?.kind).toBe("component");
    expect(manifest.layerMap?.Badge?.component).toBe("offer-badge@2");
    expect(manifest.rules?.palette).toEqual(["#F4E7D3", "#3B2A20", "#D96C3B"]);
    expect(manifest.thumbnail).toBe("thumbnails/instagram-post@3.png");
  });

  it("inspects the newest version by default and pins ?version explicitly", () => {
    const catalog = TemplateCatalog.load();
    const newest = expectOk(catalog.inspect("instagram-post"));
    expect(newest.version).toBe(3);
    const pinned = expectOk(catalog.inspect("instagram-post", 3));
    expect(pinned.id).toBe("instagram-post");
  });

  it("returns typed unknown_template with the id pins in the hint", () => {
    const catalog = TemplateCatalog.load();
    const result = catalog.inspect("no-such-template");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("unknown_template");
      for (const pin of SEED_TEMPLATE_PINS) {
        expect(result.hint).toContain(pin);
      }
    }
    const missingVersion = catalog.inspect("instagram-post", 9);
    expect(missingVersion.ok).toBe(false);
    if (!missingVersion.ok) {
      expect(missingVersion.code).toBe("unknown_template");
      expect(missingVersion.hint).toContain("instagram-post@3");
    }
  });

  it("returns typed unknown_component with the id pins in the hint", () => {
    const catalog = TemplateCatalog.load();
    const result = catalog.inspectComponent("no-such-component");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("unknown_component");
      expect(result.hint).toContain("offer-badge@2");
    }
    const missingVersion = catalog.inspectComponent("offer-badge", 1);
    expect(missingVersion.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Service: filter + pin helpers (engine template.list/component.list semantics)
// ---------------------------------------------------------------------------

describe("catalog filter helpers", () => {
  it("tagsMatchAll is AND + case-insensitive (engine semantics)", () => {
    const tags = ["Social", "promo"];
    expect(tagsMatchAll(tags, ["social"])).toBe(true);
    expect(tagsMatchAll(tags, ["social", "PROMO"])).toBe(true);
    expect(tagsMatchAll(tags, ["social", "video"])).toBe(false);
    expect(tagsMatchAll(tags, [])).toBe(true);
  });

  it("queryMatches is a case-insensitive substring over the given fields", () => {
    expect(queryMatches("INSTA", ["instagram-post", "Instagram Post"])).toBe(true);
    expect(queryMatches("post", ["instagram-post", "Instagram Post"])).toBe(true);
    expect(queryMatches("youtube", ["instagram-post", "Instagram Post"])).toBe(false);
    expect(queryMatches(undefined, ["anything"])).toBe(true);
  });

  it("formatPins caps the hint at SHOWN_PINS with an ellipsis", () => {
    const many = Array.from({ length: 10 }, (_, i) => `t${i}@1`);
    expect(formatPins([])).toBe("the catalog is empty");
    const formatted = formatPins(many);
    expect(formatted.endsWith("…")).toBe(true);
    expect(formatted.split(", ").length).toBe(9); // 8 pins + the ellipsis slot
  });

  it("workspaceTemplateId is deterministic per natural key and unique across keys", () => {
    const a = workspaceTemplateId(ORG_A, "spring-sale-post", 1);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(workspaceTemplateId(ORG_A, "spring-sale-post", 1)).toBe(a);
    expect(workspaceTemplateId(ORG_B, "spring-sale-post", 1)).not.toBe(a);
    expect(workspaceTemplateId(ORG_A, "spring-sale-post", 2)).not.toBe(a);
  });
});

// ---------------------------------------------------------------------------
// Routes: GET /v1/templates — cards (§7.4 discovery shape, NOT full manifests)
// ---------------------------------------------------------------------------

describe("GET /v1/templates", () => {
  it("lists the seed templates as discovery cards", async () => {
    const harness = makeHarness();
    const res = await get(harness, "/v1/templates");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { templates: Card[] };
    expect(body.templates.length).toBeGreaterThanOrEqual(SEED_TEMPLATE_PINS.length);
    const card = body.templates.find((entry) => entry.id === "instagram-post");
    expect(card).toBeDefined();
    expect(card).toMatchObject({
      id: "instagram-post",
      version: 3,
      ref: "instagram-post@3",
      name: "Instagram Post — Promo",
      tags: ["social", "promo", "square"],
      canvas: { width: 1080, height: 1080 },
      slots: ["badge", "headline", "logo", "photo", "subhead"],
    });
    // Cards are deliberately NOT the full manifest (§7.4 list shape):
    // slots are NAMES, and layerMap/rules never appear.
    expect(card).not.toHaveProperty("layerMap");
    expect(card).not.toHaveProperty("rules");
    for (const slot of card?.slots ?? []) {
      expect(typeof slot).toBe("string");
    }
  });

  it("filters by tags with AND semantics, case-insensitively", async () => {
    const harness = makeHarness();
    const res = await get(harness, "/v1/templates?tags=social");
    const body = (await res.json()) as { templates: Card[] };
    expect(body.templates.map((card) => card.id).sort()).toEqual([
      "instagram-post",
      "youtube-thumbnail",
    ]);

    const both = await get(harness, "/v1/templates?tags=social,video");
    const bothBody = (await both.json()) as { templates: Card[] };
    expect(bothBody.templates.map((card) => card.id)).toEqual(["youtube-thumbnail"]);

    const upper = await get(harness, "/v1/templates?tags=SOCIAL");
    const upperBody = (await upper.json()) as { templates: Card[] };
    expect(upperBody.templates.length).toBe(2);

    const none = await get(harness, "/v1/templates?tags=does-not-exist");
    const noneBody = (await none.json()) as { templates: Card[] };
    expect(noneBody.templates).toEqual([]);
  });

  it("filters by a query substring over id, name and description", async () => {
    const harness = makeHarness();
    const byId = await get(harness, "/v1/templates?query=instagram");
    const byIdBody = (await byId.json()) as { templates: Card[] };
    expect(byIdBody.templates.map((card) => card.id)).toEqual(["instagram-post"]);

    const byName = await get(harness, "/v1/templates?query=Promo");
    const byNameBody = (await byName.json()) as { templates: Card[] };
    expect(byNameBody.templates.map((card) => card.id)).toEqual(["instagram-post"]);

    const byDescription = await get(harness, "/v1/templates?query=16%3A9");
    const byDescriptionBody = (await byDescription.json()) as { templates: Card[] };
    expect(byDescriptionBody.templates.map((card) => card.id).sort()).toEqual([
      "presentation-slide",
      "youtube-thumbnail",
    ]);
  });

  it("rejects an empty tags list and an overlong query with 422", async () => {
    const harness = makeHarness();
    const emptyTags = await get(harness, "/v1/templates?tags=%2C+%2C");
    expect(emptyTags.status).toBe(422);
    expect((await errorEnvelope(emptyTags)).code).toBe("validation_failed");

    const longQuery = await get(
      harness,
      `/v1/templates?query=${"a".repeat(513)}`,
    );
    expect(longQuery.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Routes: GET /v1/templates/:id — the full manifest with version pinning
// ---------------------------------------------------------------------------

describe("GET /v1/templates/:id", () => {
  it("returns the full manifest (newest version by default)", async () => {
    const harness = makeHarness();
    const res = await get(harness, "/v1/templates/instagram-post");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { template: Record<string, unknown> };
    expect(body.template.id).toBe("instagram-post");
    expect(body.template.version).toBe(3);
    expect(body.template).toHaveProperty("layerMap");
    expect(body.template).toHaveProperty("rules");
  });

  it("honours ?version= pins and 404s missing versions with the pin hint", async () => {
    const harness = makeHarness();
    const pinned = await get(harness, "/v1/templates/instagram-post?version=3");
    expect(pinned.status).toBe(200);
    const pinnedBody = (await pinned.json()) as { template: { version: number } };
    expect(pinnedBody.template.version).toBe(3);

    const missing = await get(harness, "/v1/templates/instagram-post?version=9");
    expect(missing.status).toBe(404);
    const envelope = await errorEnvelope(missing);
    expect(envelope.code).toBe("unknown_template");
    expect(envelope.hint).toContain("instagram-post@3");
  });

  it("404s an unknown id with unknown_template and the id pins in the hint", async () => {
    const harness = makeHarness();
    const res = await get(harness, "/v1/templates/no-such-template");
    expect(res.status).toBe(404);
    const envelope = await errorEnvelope(res);
    expect(envelope.code).toBe("unknown_template");
    for (const pin of SEED_TEMPLATE_PINS) {
      expect(envelope.hint).toContain(pin);
    }
  });

  it("422s a malformed version pin", async () => {
    const harness = makeHarness();
    const res = await get(harness, "/v1/templates/instagram-post?version=abc");
    expect(res.status).toBe(422);
    expect((await errorEnvelope(res)).code).toBe("validation_failed");
  });
});

// ---------------------------------------------------------------------------
// Routes: GET /v1/components (§8.3 discovery)
// ---------------------------------------------------------------------------

describe("GET /v1/components", () => {
  it("lists the ten start components as discovery cards", async () => {
    const harness = makeHarness();
    const res = await get(harness, "/v1/components");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { components: Card[] };
    expect(body.components.length).toBeGreaterThanOrEqual(SEED_COMPONENT_PINS.length);
    const card = body.components.find((entry) => entry.id === "offer-badge");
    expect(card).toMatchObject({
      id: "offer-badge",
      version: 2,
      ref: "offer-badge@2",
      name: "Offer Badge",
      tags: ["badge", "promo"],
      defaultSize: { width: 180, height: 180 },
      license: "public",
      variables: ["bg", "label", "showRibbon", "textColor"],
      comps: ["default", "light", "dark"],
    });
  });

  it("filters components by tags and query", async () => {
    const harness = makeHarness();
    const badge = await get(harness, "/v1/components?tags=badge");
    const badgeBody = (await badge.json()) as { components: Card[] };
    expect(badgeBody.components.map((card) => card.id).sort()).toEqual([
      "offer-badge",
      "price-tag",
    ]);

    const avatar = await get(harness, "/v1/components?query=avatar");
    const avatarBody = (await avatar.json()) as { components: Card[] };
    expect(avatarBody.components.map((card) => card.id)).toEqual(["avatar-circle"]);
  });

  it("inspects a component with version pinning and typed misses", async () => {
    const harness = makeHarness();
    const res = await get(harness, "/v1/components/offer-badge");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { component: Record<string, unknown> };
    expect(body.component.id).toBe("offer-badge");
    expect(body.component.version).toBe(2);
    expect(body.component).toHaveProperty("variables");

    const pinned = await get(harness, "/v1/components/offer-badge?version=2");
    expect(pinned.status).toBe(200);

    const missingVersion = await get(harness, "/v1/components/offer-badge?version=1");
    expect(missingVersion.status).toBe(404);
    expect((await errorEnvelope(missingVersion)).code).toBe("unknown_component");

    const unknown = await get(harness, "/v1/components/nope");
    expect(unknown.status).toBe(404);
    const envelope = await errorEnvelope(unknown);
    expect(envelope.code).toBe("unknown_component");
    expect(envelope.hint).toContain("offer-badge@2");
  });
});

// ---------------------------------------------------------------------------
// Auth + per-org rate limiting (§1.5 rule 5)
// ---------------------------------------------------------------------------

describe("auth and rate limits", () => {
  it("401s unauthenticated catalog reads", async () => {
    const harness = makeHarness();
    const res = await get(harness, "/v1/templates", { token: "no-such-token" });
    expect(res.status).toBe(401);
    const envelope = await errorEnvelope(res);
    expect(envelope.code).toBe("unauthorized");
  });

  it("rate-limits per org: 429 with Retry-After, other orgs unaffected", async () => {
    const now = () => FIXED_NOW_MS;
    const limiter = new RateLimiter({ kv: new InMemoryKV(now), now });
    const harness = makeHarness({ limiter, rateLimit: { limit: 2, windowSec: 60 } });

    const first = await get(harness, "/v1/templates");
    expect(first.status).toBe(200);
    expect(first.headers.get("x-ratelimit-limit")).toBe("2");
    expect(first.headers.get("x-ratelimit-remaining")).toBe("1");

    const second = await get(harness, "/v1/templates");
    expect(second.status).toBe(200);
    expect(second.headers.get("x-ratelimit-remaining")).toBe("0");

    const third = await get(harness, "/v1/templates");
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBe("30");
    const envelope = await errorEnvelope(third);
    expect(envelope.code).toBe("rate_limited");
    expect(envelope.retryable).toBe(true);

    // Per-org buckets (§1.5 rule 5): org B still has its full burst.
    const orgB = await get(harness, "/v1/templates", { token: TOKEN_ADMIN_B });
    expect(orgB.status).toBe(200);
    expect(orgB.headers.get("x-ratelimit-remaining")).toBe("1");
  });

  it("fails open when the limiter KV errors (W4-D posture)", async () => {
    class ExplodingKv extends InMemoryKV {
      async get(): Promise<string | null> {
        throw new Error("kv down");
      }
    }
    const limiter = new RateLimiter({ kv: new ExplodingKv(), now: () => FIXED_NOW_MS });
    const harness = makeHarness({ limiter, rateLimit: { limit: 1, windowSec: 60 } });
    const res = await get(harness, "/v1/templates");
    expect(res.status).toBe(200); // limiter outage ≠ catalog outage
  });
});

// ---------------------------------------------------------------------------
// POST /v1/workspaces/:id/templates — registration (§7.2 license, §15.1/§15.2)
// ---------------------------------------------------------------------------

describe("POST /v1/workspaces/:id/templates", () => {
  it("registers a workspace template (admin+, default license workspace)", async () => {
    const harness = makeHarness();
    const res = await post(harness, `/v1/workspaces/${ORG_A}/templates`, REGISTRATION_MANIFEST, {
      token: TOKEN_ADMIN_A,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      workspace_id: string;
      template_id: string;
      version: number;
      license: string;
      created_at: string;
      duplicate: boolean;
    };
    expect(body.template_id).toBe("spring-sale-post");
    expect(body.workspace_id).toBe(ORG_A);
    expect(body.version).toBe(1);
    expect(body.license).toBe("workspace");
    expect(body.duplicate).toBe(false);
    expect(body.created_at).toBe("2026-01-15T10:00:00.000Z");

    expect(harness.store.rows.length).toBe(1);
    const row = harness.store.rows[0];
    expect(row?.organizationId).toBe(ORG_A);
    expect(row?.source).toBe("workspace");
    // The stored manifest carries the effective license (§7.2 normalized).
    expect((row?.manifest as Record<string, unknown>).license).toBe("workspace");
  });

  it("stores license=public rows when the manifest declares it", async () => {
    const harness = makeHarness();
    const res = await post(
      harness,
      `/v1/workspaces/${ORG_A}/templates`,
      { ...REGISTRATION_MANIFEST, id: "public-post", license: "public" },
      { token: TOKEN_OWNER_A },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { license: string };
    expect(body.license).toBe("public");
    expect(harness.store.rows[0]?.source).toBe("public");
  });

  it("is idempotent: the same natural key returns the existing row", async () => {
    const harness = makeHarness();
    const first = await post(harness, `/v1/workspaces/${ORG_A}/templates`, REGISTRATION_MANIFEST, {
      token: TOKEN_ADMIN_A,
    });
    expect(first.status).toBe(201);
    const again = await post(harness, `/v1/workspaces/${ORG_A}/templates`, REGISTRATION_MANIFEST, {
      token: TOKEN_ADMIN_A,
      idempotencyKey: "a-different-key",
    });
    expect(again.status).toBe(200);
    const body = (await again.json()) as { duplicate: boolean; id: string };
    expect(body.duplicate).toBe(true);
    expect(harness.store.rows.length).toBe(1);
  });

  it("tenant guard: another org's admin gets 403 cross_tenant_denied", async () => {
    const harness = makeHarness();
    const res = await post(harness, `/v1/workspaces/${ORG_A}/templates`, REGISTRATION_MANIFEST, {
      token: TOKEN_ADMIN_B,
    });
    expect(res.status).toBe(403);
    const envelope = await errorEnvelope(res);
    expect(envelope.code).toBe("cross_tenant_denied");
    expect(harness.store.rows.length).toBe(0);
  });

  it("role guard: editors and viewers get 403 forbidden (admin+ only)", async () => {
    const harness = makeHarness();
    const editor = await post(harness, `/v1/workspaces/${ORG_A}/templates`, REGISTRATION_MANIFEST, {
      token: TOKEN_EDITOR_A,
    });
    expect(editor.status).toBe(403);
    expect((await errorEnvelope(editor)).code).toBe("forbidden");

    const viewer = await post(harness, `/v1/workspaces/${ORG_A}/templates`, REGISTRATION_MANIFEST, {
      token: TOKEN_VIEWER_A,
    });
    expect(viewer.status).toBe(403);
    expect((await errorEnvelope(viewer)).code).toBe("forbidden");
    expect(harness.store.rows.length).toBe(0);
  });

  it("storage failures surface as retryable typed envelopes", async () => {
    const harness = makeHarness();
    harness.store.failNextInsert = true;
    const res = await post(harness, `/v1/workspaces/${ORG_A}/templates`, REGISTRATION_MANIFEST, {
      token: TOKEN_ADMIN_A,
    });
    expect(res.status).toBe(500);
    const envelope = await errorEnvelope(res);
    expect(envelope.code).toBe("storage_error");
    expect(envelope.retryable).toBe(true);
  });

  it("422s a missing Idempotency-Key and an invalid manifest", async () => {
    const harness = makeHarness();
    const noKey = await post(harness, `/v1/workspaces/${ORG_A}/templates`, REGISTRATION_MANIFEST, {
      token: TOKEN_ADMIN_A,
      omitIdempotencyKey: true,
    });
    expect(noKey.status).toBe(422);
    expect((await errorEnvelope(noKey)).code).toBe("validation_failed");

    const invalid = await post(
      harness,
      `/v1/workspaces/${ORG_A}/templates`,
      { ...REGISTRATION_MANIFEST, version: 0 },
      { token: TOKEN_ADMIN_A },
    );
    expect(invalid.status).toBe(422);
    expect(harness.store.rows.length).toBe(0);
  });

  it("400s malformed JSON bodies", async () => {
    const harness = makeHarness();
    const res = await harness.app.request(`/v1/workspaces/${ORG_A}/templates`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN_ADMIN_A}`,
        "content-type": "application/json",
        "Idempotency-Key": "idem-catalog-1",
      },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect((await errorEnvelope(res)).code).toBe("validation_failed");
  });
});

// ---------------------------------------------------------------------------
// Loader: skip-and-log invalid manifests, fail loud on an empty catalog
// ---------------------------------------------------------------------------

describe("catalog loading (skip invalid, fail loud on zero)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempCatalog(): string {
    const dir = mkdtempSync(join(tmpdir(), "studio-catalog-"));
    tempDirs.push(dir);
    return dir;
  }

  it("skips invalid manifests and keeps the valid ones", () => {
    const dir = makeTempCatalog();
    mkdirSync(join(dir, "templates", "good-post@1"), { recursive: true });
    writeFileSync(
      join(dir, "templates", "good-post@1", "manifest.json"),
      JSON.stringify({
        id: "good-post",
        version: 1,
        name: "Good Post",
        canvas: { width: 1080, height: 1080 },
        slots: {},
      }),
    );
    mkdirSync(join(dir, "templates", "bad-post@1"), { recursive: true });
    writeFileSync(
      join(dir, "templates", "bad-post@1", "manifest.json"),
      JSON.stringify({ id: "Bad_ID", version: 1, name: "x", canvas: { width: 1, height: 1 } }),
    );
    mkdirSync(join(dir, "components", "mini-badge@1"), { recursive: true });
    writeFileSync(
      join(dir, "components", "mini-badge@1", "component.json"),
      JSON.stringify({
        id: "mini-badge",
        version: 1,
        name: "Mini Badge",
        license: "public",
        defaultSize: { width: 64, height: 64 },
      }),
    );

    const catalog = TemplateCatalog.load({ dir });
    expect(catalog.templatePins()).toEqual(["good-post@1"]);
    expect(catalog.componentPins()).toEqual(["mini-badge@1"]);
  });

  it("fails loud when zero valid manifests load (boot refuses)", () => {
    const dir = makeTempCatalog();
    mkdirSync(join(dir, "templates"), { recursive: true });
    mkdirSync(join(dir, "components"), { recursive: true });
    expect(() => TemplateCatalog.load({ dir })).toThrow(CatalogBootError);
  });

  it("honours the STUDIO_CATALOG_DIR env override", () => {
    const dir = makeTempCatalog();
    mkdirSync(join(dir, "templates", "env-post@1"), { recursive: true });
    writeFileSync(
      join(dir, "templates", "env-post@1", "manifest.json"),
      JSON.stringify({
        id: "env-post",
        version: 1,
        name: "Env Post",
        canvas: { width: 100, height: 100 },
        slots: {},
      }),
    );
    const catalog = TemplateCatalog.load({ env: { STUDIO_CATALOG_DIR: dir } });
    expect(catalog.templatePins()).toEqual(["env-post@1"]);
  });

  it("refuses to boot on a malformed STUDIO_CATALOG_DIR value", () => {
    // Empty string is a misconfiguration, not "unset" (fail fast, AGENTS.md).
    expect(() =>
      TemplateCatalog.load({ env: { STUDIO_CATALOG_DIR: "   " } }),
    ).toThrow();
  });

  it("a missing catalog dir also fails loud (zero manifests)", () => {
    const dir = makeTempCatalog();
    expect(() => TemplateCatalog.load({ dir: join(dir, "does-not-exist") })).toThrow(
      CatalogBootError,
    );
  });
});
