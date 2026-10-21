/**
 * Pure-logic tests for the §13 endpoint constants (W8-O): fixed paths,
 * segment encoding and the deterministic `withQuery` builder. No network.
 */
import { describe, expect, it } from "vitest";
import { endpoints, withQuery } from "./endpoints";

describe("fixed endpoint paths (pinned to apps/gateway/src/openapi.ts)", () => {
  it("documents group", () => {
    expect(endpoints.documents.list).toBe("/documents");
    expect(endpoints.documents.detail("doc_1")).toBe("/documents/doc_1");
    expect(endpoints.documents.versions("doc_1")).toBe("/documents/doc_1/versions");
    expect(endpoints.documents.restoreVersion("doc_1", "ver_2")).toBe(
      "/documents/doc_1/versions/ver_2/restore",
    );
    expect(endpoints.documents.runs("doc_1")).toBe("/documents/doc_1/runs");
    expect(endpoints.documents.commands("doc_1")).toBe("/documents/doc_1/commands");
    expect(endpoints.documents.undo("doc_1")).toBe("/documents/doc_1/undo");
    expect(endpoints.documents.redo("doc_1")).toBe("/documents/doc_1/redo");
    expect(endpoints.documents.exports("doc_1")).toBe("/documents/doc_1/exports");
    expect(endpoints.documents.preview("doc_1")).toBe("/documents/doc_1/preview");
    expect(endpoints.documents.layers("doc_1")).toBe("/documents/doc_1/layers");
    expect(endpoints.documents.inspect("doc_1")).toBe("/documents/doc_1/inspect");
  });

  it("runs group — §13.1 REST + the §13.2 SSE stream path", () => {
    expect(endpoints.runs.list).toBe("/runs");
    expect(endpoints.runs.create).toBe("/runs");
    expect(endpoints.runs.detail("run_018f")).toBe("/runs/run_018f");
    expect(endpoints.runs.cancel("run_018f")).toBe("/runs/run_018f/cancel");
    expect(endpoints.runs.events("run_018f")).toBe("/runs/run_018f/events");
  });

  it("uploads / assets / catalog / credits / billing groups", () => {
    expect(endpoints.uploads.create).toBe("/uploads");
    expect(endpoints.assets.list).toBe("/assets");
    expect(endpoints.assets.detail("ast_1")).toBe("/assets/ast_1");
    expect(endpoints.templates.list).toBe("/templates");
    expect(endpoints.templates.detail("instagram-post")).toBe("/templates/instagram-post");
    expect(endpoints.components.list).toBe("/components");
    expect(endpoints.components.detail("offer-badge")).toBe("/components/offer-badge");
    expect(endpoints.credits.balance).toBe("/credits");
    expect(endpoints.billing.checkout).toBe("/billing/checkout");
    expect(endpoints.billing.portal).toBe("/billing/portal");
    expect(endpoints.billing.usage).toBe("/usage");
  });

  it("workspaces group — members, invites, token accept flow", () => {
    expect(endpoints.workspaces.list).toBe("/workspaces");
    expect(endpoints.workspaces.detail("ws_1")).toBe("/workspaces/ws_1");
    expect(endpoints.workspaces.members("ws_1")).toBe("/workspaces/ws_1/members");
    expect(endpoints.workspaces.member("ws_1", "user_2")).toBe(
      "/workspaces/ws_1/members/user_2",
    );
    expect(endpoints.workspaces.invites("ws_1")).toBe("/workspaces/ws_1/invites");
    expect(endpoints.workspaces.invite("ws_1", "inv_3")).toBe(
      "/workspaces/ws_1/invites/inv_3",
    );
    expect(endpoints.workspaces.inviteByToken("tok_9")).toBe("/invites/tok_9");
    expect(endpoints.workspaces.acceptInvite("tok_9")).toBe("/invites/tok_9/accept");
  });

  it("session / health / openapi groups", () => {
    expect(endpoints.session.me).toBe("/me");
    expect(endpoints.session.auth("sign-out")).toBe("/auth/sign-out");
    expect(endpoints.health.live).toBe("/health");
    expect(endpoints.health.deep).toBe("/health/deep");
    expect(endpoints.openapi.document).toBe("/openapi.json");
  });
});

describe("segment encoding (ids are never trusted input — §5.7)", () => {
  it("percent-encodes every dynamic segment", () => {
    expect(endpoints.documents.detail("my doc")).toBe("/documents/my%20doc");
    expect(endpoints.runs.detail("a/b")).toBe("/runs/a%2Fb");
    expect(endpoints.workspaces.member("ws 1", "u?x")).toBe("/workspaces/ws%201/members/u%3Fx");
  });
});

describe("withQuery", () => {
  it("appends set params in insertion order", () => {
    expect(withQuery("/documents", { limit: 20, include_archived: false })).toBe(
      "/documents?limit=20&include_archived=false",
    );
    expect(withQuery("/templates", { b: 1, a: 2 })).toBe("/templates?b=1&a=2");
  });

  it("skips null, undefined and empty-string values", () => {
    expect(withQuery("/assets", { cursor: null, limit: undefined, q: "", kind: "image" })).toBe(
      "/assets?kind=image",
    );
  });

  it("returns the bare path when nothing survives", () => {
    expect(withQuery("/documents", {})).toBe("/documents");
    expect(withQuery("/documents", { cursor: null })).toBe("/documents");
  });
});
