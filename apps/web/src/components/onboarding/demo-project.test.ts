// demo-project tests — §24.1 coffee demo: URL contract with the compose page
// (W8-D), POST /v1/documents body shape, and typed failure envelopes. All
// fetch traffic is stubbed.

import { describe, expect, it } from "vitest";
import {
  DEMO_BRIEF,
  DEMO_DOCUMENT_NAME,
  DEMO_TEMPLATE_ID,
  buildComposeUrl,
  buildCreateDocumentBody,
  extractDocumentId,
  parseComposeUrl,
  seedDemoDocument,
  type FetchLike,
} from "./demo-project";

const response = (status: number, body?: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json:
      body === undefined
        ? async () => {
            throw new Error("no body");
          }
        : async () => body,
  }) as unknown as Response;

describe("§24.1 demo constants", () => {
  it("uses the worked example's template and brief", () => {
    expect(DEMO_TEMPLATE_ID).toBe("instagram-post@3");
    expect(DEMO_BRIEF).toContain("Coffee shop promo post, warm and cozy");
    expect(DEMO_BRIEF).toContain("headline 'Fresh roasted, every morning'");
    expect(DEMO_BRIEF).toContain("sub 'Open 7–5 · Main St', use the latte photo.");
  });
});

describe("buildComposeUrl (W8-D contract)", () => {
  it("percent-encodes the template id (@ becomes %40)", () => {
    const url = buildComposeUrl();
    expect(url.startsWith("/compose?")).toBe(true);
    expect(url).toContain("template=instagram-post%403");
    expect(url).not.toContain("instagram-post@3");
  });

  it("round-trips template and brief through parseComposeUrl", () => {
    const parsed = parseComposeUrl(buildComposeUrl());
    expect(parsed.template).toBe(DEMO_TEMPLATE_ID);
    expect(parsed.brief).toBe(DEMO_BRIEF);
  });

  it("builds an exact query string for custom values", () => {
    expect(buildComposeUrl("poster@1", "hi there")).toBe(
      "/compose?template=poster%401&brief=hi+there",
    );
  });

  it("parses a URL without query params", () => {
    expect(parseComposeUrl("/compose")).toEqual({ template: null, brief: null });
  });
});

describe("buildCreateDocumentBody", () => {
  it("matches the §13 create shape by default", () => {
    expect(buildCreateDocumentBody()).toEqual({
      name: DEMO_DOCUMENT_NAME,
      template: DEMO_TEMPLATE_ID,
    });
  });

  it("attaches project_id only when provided and non-empty", () => {
    expect(buildCreateDocumentBody({ projectId: "p_1" }).project_id).toBe("p_1");
    expect(buildCreateDocumentBody({ projectId: "" }).project_id).toBeUndefined();
    expect(buildCreateDocumentBody().project_id).toBeUndefined();
  });
});

describe("extractDocumentId", () => {
  it.each([
    ["{id}", { id: "d1" }, "d1"],
    ["{document_id}", { document_id: "d2" }, "d2"],
    ["{data:{id}}", { data: { id: "d3" } }, "d3"],
    ["{data:{document_id}}", { data: { document_id: "d4" } }, "d4"],
  ])("extracts from %s", (_name, payload, expected) => {
    expect(extractDocumentId(payload)).toBe(expected);
  });

  it.each([
    ["null", null],
    ["empty object", {}],
    ["numeric id", { id: 42 }],
    ["empty string id", { id: "" }],
    ["primitive", "d5"],
  ])("yields null for %s", (_name, payload) => {
    expect(extractDocumentId(payload)).toBeNull();
  });
});

describe("seedDemoDocument", () => {
  it("POSTs the §13 body to /v1/documents and returns the document id", async () => {
    let captured: { input?: unknown; init?: RequestInit } = {};
    const spy: FetchLike = async (input, init) => {
      captured = { input, init };
      return response(201, { id: "doc_9" });
    };
    const result = await seedDemoDocument({ projectId: "p_7" }, spy);
    expect(result).toEqual({ ok: true, documentId: "doc_9" });
    expect(captured.input).toBe("/v1/documents");
    expect(captured.init?.method).toBe("POST");
    const body = JSON.parse(String(captured.init?.body)) as Record<string, unknown>;
    expect(body.template).toBe("instagram-post@3");
    expect(body.name).toBe(DEMO_DOCUMENT_NAME);
    expect(body.project_id).toBe("p_7");
  });

  it("succeeds with a null id when the response carries no id (compose link doesn't need it)", async () => {
    const result = await seedDemoDocument({}, async () => response(200, {}));
    expect(result).toEqual({ ok: true, documentId: null });
  });

  it.each([
    [401, "demo.unauthorized", false],
    [404, "demo.template-missing", false],
    [429, "demo.rate-limited", true],
    [500, "demo.create-failed", true],
  ])(
    "maps HTTP %i to a typed envelope (%s, retryable=%s)",
    async (status, code, retryable) => {
      const result = await seedDemoDocument({}, async () => response(status, {}));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(code);
        expect(result.retryable).toBe(retryable);
        expect(result.message.length).toBeGreaterThan(0);
        expect(result.hint.length).toBeGreaterThan(0);
      }
    },
  );

  it("swallows network errors into a retryable envelope", async () => {
    const dead: FetchLike = async () => {
      throw new Error("offline");
    };
    const result = await seedDemoDocument({}, dead);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("demo.network");
      expect(result.retryable).toBe(true);
    }
  });
});
