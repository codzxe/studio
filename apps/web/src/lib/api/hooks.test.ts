/**
 * Pure-logic tests for the shared react-query layer (W8-O): the typed
 * queryKeys factory (frozen to the shipped conventions — see hooks.ts
 * header), the envelope-aware retry/backoff policy, and the 401 seam.
 * No network, no DOM, hooks themselves are never rendered here.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "./client";
import {
  API_QUERY_MAX_RETRIES,
  apiQueryRetry,
  apiRetryDelay,
  handleUnauthorized,
  isUnauthorizedError,
  queryKeys,
  setUnauthorizedHandler,
} from "./hooks";

// ---------------------------------------------------------------------------
// queryKeys — every shape must equal the convention it froze (cross-module
// invalidations depend on array equality)
// ---------------------------------------------------------------------------

describe("queryKeys.documents", () => {
  it("mirrors the W8-C documentsKeys factory", () => {
    expect(queryKeys.documents.all).toEqual(["documents"]);
    expect(queryKeys.documents.lists).toEqual(["documents", "list"]);
    expect(queryKeys.documents.list({ limit: 20, includeArchived: false })).toEqual([
      "documents",
      "list",
      { limit: 20, includeArchived: false },
    ]);
    expect(queryKeys.documents.details).toEqual(["documents", "detail"]);
    expect(queryKeys.documents.detail("doc_1")).toEqual(["documents", "detail", "doc_1"]);
  });

  it("keeps W8-A dashboard + W8-H version keys intact", () => {
    expect(queryKeys.documents.recent(8, "ws_1")).toEqual([
      "documents",
      "recent",
      8,
      "ws_1",
    ]);
    expect(queryKeys.documents.versions("doc_1")).toEqual(["documents", "doc_1", "versions"]);
    expect(queryKeys.documents.versionDiff("doc_1", 2, 5)).toEqual([
      "documents",
      "doc_1",
      "diff",
      2,
      5,
    ]);
  });

  it("has detail keys that extend their prefix (invalidation reach)", () => {
    expect(queryKeys.documents.detail("doc_1").slice(0, 2)).toEqual(
      queryKeys.documents.details,
    );
  });
});

describe("queryKeys.runs / assets", () => {
  it("freezes the singular \"run\" detail key (timeline page contract)", () => {
    expect(queryKeys.runs.detail("run_018f")).toEqual(["run", "run_018f"]);
  });

  it("mirrors W8-A recent-runs and W8-I asset keys", () => {
    expect(queryKeys.runs.recent(5, null)).toEqual(["runs", "recent", 5, null]);
    expect(queryKeys.assets.all).toEqual(["assets"]);
    expect(queryKeys.assets.list).toEqual(["assets", "list"]);
    expect(queryKeys.assets.listPage(24)).toEqual(["assets", "list", 24]);
    expect(queryKeys.assets.url("ast_1")).toEqual(["assets", "url", "ast_1"]);
  });
});

describe("queryKeys.session / catalog / comments / auth", () => {
  it("mirrors W8-A session keys", () => {
    expect(queryKeys.session.all).toEqual(["session"]);
    expect(queryKeys.session.me).toEqual(["session", "me"]);
    expect(queryKeys.session.workspaces).toEqual(["session", "workspaces"]);
    expect(queryKeys.session.credits("ws_1")).toEqual(["session", "credits", "ws_1"]);
  });

  it("mirrors W8-J catalog keys", () => {
    expect(queryKeys.catalog.templates({ tags: ["social"] })).toEqual([
      "catalog",
      "templates",
      { tags: ["social"] },
    ]);
    expect(queryKeys.catalog.template("instagram-post", 3)).toEqual([
      "catalog",
      "template",
      "instagram-post",
      3,
    ]);
  });

  it("mirrors W8-F comments + invite keys", () => {
    expect(queryKeys.comments.forDocument("doc_1")).toEqual(["comments", "doc_1"]);
    expect(queryKeys.auth.invitation("tok_1")).toEqual(["auth", "invitation", "tok_1"]);
  });
});

// ---------------------------------------------------------------------------
// Retry / backoff policy (§13.3 retryable flags; 429 backoff)
// ---------------------------------------------------------------------------

const apiError = (status: number, retryable: boolean) =>
  new ApiError({
    code: "test",
    message: "unit",
    status,
    retryable,
  });

describe("apiQueryRetry", () => {
  it("retries retryable errors up to API_QUERY_MAX_RETRIES", () => {
    expect(apiQueryRetry(0, apiError(503, true))).toBe(true);
    expect(apiQueryRetry(1, apiError(0, true))).toBe(true); // network/timeout
    expect(apiQueryRetry(API_QUERY_MAX_RETRIES, apiError(500, true))).toBe(false);
  });

  it("always retries 429 (back off, don't give up)", () => {
    expect(apiQueryRetry(0, apiError(429, false))).toBe(true);
  });

  it("never retries fatal envelopes or non-ApiError throws", () => {
    expect(apiQueryRetry(0, apiError(409, false))).toBe(false);
    expect(apiQueryRetry(0, apiError(404, false))).toBe(false);
    expect(apiQueryRetry(0, new Error("contract drift"))).toBe(false);
    expect(apiQueryRetry(0, undefined)).toBe(false);
  });
});

describe("apiRetryDelay", () => {
  it("doubles per attempt and caps at 30 s", () => {
    expect(apiRetryDelay(0)).toBe(1_000);
    expect(apiRetryDelay(1)).toBe(2_000);
    expect(apiRetryDelay(2)).toBe(4_000);
    expect(apiRetryDelay(7)).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// 401 seam
// ---------------------------------------------------------------------------

describe("401 seam", () => {
  afterEach(() => {
    setUnauthorizedHandler(null);
  });

  it("detects only ApiError 401", () => {
    expect(isUnauthorizedError(apiError(401, false))).toBe(true);
    expect(isUnauthorizedError(apiError(403, false))).toBe(false);
    expect(isUnauthorizedError(new Error("nope"))).toBe(false);
  });

  it("notifies the installed handler for 401 envelopes only", () => {
    const seen: string[] = [];
    setUnauthorizedHandler((error) => seen.push(error.code));
    handleUnauthorized(apiError(401, false));
    handleUnauthorized(apiError(500, true));
    handleUnauthorized(new Error("drift"));
    expect(seen).toEqual(["test"]); // only the 401 envelope reached the handler
  });

  it("is a no-op until a handler is installed", () => {
    expect(() => handleUnauthorized(apiError(401, false))).not.toThrow();
  });
});
