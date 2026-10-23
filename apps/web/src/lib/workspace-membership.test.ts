/**
 * workspace-membership tests (W2-01) — the pure RSC seam every `/w` page
 * shares: the `/v1/me` membership parse (§7.2 wire restated), the `?ws`
 * resolution (first-membership default; explicit-but-unknown → the 404 arm,
 * hard rule 3) and the 401/404/raise classification against the gateway
 * error shape. `@/lib/gateway` is mocked (the seam's own tests cover the
 * unwrap; this module only consumes its guard).
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/gateway", () => ({
  GatewayHttpError: class GatewayHttpError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(init: { status: number; code: string; message: string }) {
      super(init.message);
      this.status = init.status;
      this.code = init.code;
    }
    get isNotFound(): boolean {
      return (
        this.status === 404 || this.code === "NOT_FOUND" || this.code === "WORKSPACE_NOT_FOUND"
      );
    }
  },
  isGatewayHttpError: (error: unknown): boolean =>
    error instanceof Error && error.constructor.name === "GatewayHttpError",
}));

import { GatewayHttpError } from "@/lib/gateway";
import {
  canEditProjects,
  canManageWorkspace,
  classifyGatewayError,
  findMembership,
  parseMemberships,
  resolveActiveWorkspace,
  signInPath,
} from "@/lib/workspace-membership";

// ---------------------------------------------------------------------------
// Wire fixtures (the real §7.2 shapes)
// ---------------------------------------------------------------------------

const ME_BODY = {
  user: { id: "user_1", name: "Alex Jordan", email: "alex@example.com" },
  plan: { plan: "pro", creditsBalance: 1, includedCredits: 2, renewsAt: null },
  memberships: [
    {
      workspaceId: "ws_first",
      role: "owner",
      workspace: { id: "ws_first", name: "First Films", slug: "first-films" },
    },
    {
      workspaceId: "ws_second",
      role: "viewer",
      workspace: { id: "ws_second", name: "Second Studio", slug: "second-studio" },
    },
  ],
};

describe("parseMemberships", () => {
  it("parses the /v1/me membership rows", () => {
    const memberships = parseMemberships(ME_BODY);
    expect(memberships).toHaveLength(2);
    expect(memberships[0]).toEqual({
      workspaceId: "ws_first",
      role: "owner",
      workspace: { id: "ws_first", name: "First Films", slug: "first-films" },
    });
    expect(memberships[1]?.role).toBe("viewer");
  });

  it("skips malformed rows and tolerates hostile payloads (never throws)", () => {
    expect(parseMemberships(null)).toEqual([]);
    expect(parseMemberships("nope")).toEqual([]);
    expect(parseMemberships({ memberships: "not-an-array" })).toEqual([]);
    expect(
      parseMemberships({
        memberships: [
          { workspaceId: 42, role: "owner", workspace: { id: "a", name: "A", slug: "a" } },
          { workspaceId: "ws_ok", role: "chief", workspace: { id: "ws_ok", name: "B", slug: "b" } },
          { workspaceId: "ws_gone", role: "owner", workspace: "not-an-object" },
          null,
        ],
      }),
    ).toEqual([
      // Unknown roles degrade to viewer — the gateway re-checks capabilities.
      { workspaceId: "ws_ok", role: "viewer", workspace: { id: "ws_ok", name: "B", slug: "b" } },
    ]);
  });
});

describe("findMembership / resolveActiveWorkspace (?ws seam)", () => {
  const memberships = parseMemberships(ME_BODY);

  it("matches ?ws by workspace id, workspace row id or slug", () => {
    expect(findMembership(memberships, "ws_second")?.workspace.slug).toBe("second-studio");
    expect(findMembership(memberships, "second-studio")?.workspace.name).toBe("Second Studio");
    expect(findMembership(memberships, "first-films")?.workspaceId).toBe("ws_first");
    expect(findMembership(memberships, "ws_gone")).toBeNull();
  });

  it("defaults to the FIRST membership when ?ws is absent", () => {
    const resolution = resolveActiveWorkspace(memberships, undefined);
    expect(resolution).toEqual({
      status: "ready",
      membership: {
        workspaceId: "ws_first",
        role: "owner",
        workspace: { id: "ws_first", name: "First Films", slug: "first-films" },
      },
    });
  });

  it("resolves an explicit ?ws to that membership", () => {
    const resolution = resolveActiveWorkspace(memberships, "second-studio");
    expect(resolution.status).toBe("ready");
    if (resolution.status === "ready") {
      expect(resolution.membership.workspaceId).toBe("ws_second");
      expect(resolution.membership.role).toBe("viewer");
    }
  });

  it("404s an explicit-but-unknown ?ws (cross-tenant = 404, hard rule 3)", () => {
    expect(resolveActiveWorkspace(memberships, "ws_gone")).toEqual({
      status: "unknown-workspace",
    });
  });

  it("reports no-workspace for an empty membership list", () => {
    expect(resolveActiveWorkspace([], undefined)).toEqual({ status: "no-workspace" });
    expect(resolveActiveWorkspace([], "anything")).toEqual({ status: "no-workspace" });
  });
});

describe("classifyGatewayError (401/404 semantics)", () => {
  it("routes 401/UNAUTHORIZED to the sign-in redirect with a next round-trip", () => {
    const error = new GatewayHttpError({
      status: 401,
      code: "UNAUTHORIZED",
      message: "Sign in to continue.",
    });
    expect(classifyGatewayError(error, "/w/billing")).toEqual({
      action: "sign-in",
      next: "/w/billing",
    });
    const codeOnly = new GatewayHttpError({
      status: 500,
      code: "UNAUTHORIZED",
      message: "Session expired.",
    });
    expect(classifyGatewayError(codeOnly, "/w")).toEqual({ action: "sign-in", next: "/w" });
  });

  it("routes NOT_FOUND (incl. cross-tenant WORKSPACE_NOT_FOUND) to the 404 arm", () => {
    const notFound = new GatewayHttpError({
      status: 404,
      code: "WORKSPACE_NOT_FOUND",
      message: "Not found.",
    });
    expect(classifyGatewayError(notFound, "/w")).toEqual({ action: "not-found" });
    const codeOnly = new GatewayHttpError({
      status: 400,
      code: "NOT_FOUND",
      message: "Not found.",
    });
    expect(classifyGatewayError(codeOnly, "/w")).toEqual({ action: "not-found" });
  });

  it("rethrows everything else (and non-gateway errors) for the error boundary", () => {
    const boom = new GatewayHttpError({
      status: 500,
      code: "INTERNAL_ERROR",
      message: "Something went wrong on our side.",
    });
    expect(classifyGatewayError(boom, "/w")).toEqual({ action: "raise", error: boom });
    const network = new TypeError("fetch failed");
    expect(classifyGatewayError(network, "/w")).toEqual({ action: "raise", error: network });
  });

  it("encodes the sign-in round-trip path", () => {
    expect(signInPath("/w/billing")).toBe("/sign-in?next=%2Fw%2Fbilling");
    expect(signInPath("/w")).toBe("/sign-in?next=%2Fw");
  });
});

describe("role helpers", () => {
  it("manage: owner + admin only", () => {
    expect(canManageWorkspace("owner")).toBe(true);
    expect(canManageWorkspace("admin")).toBe(true);
    expect(canManageWorkspace("editor")).toBe(false);
    expect(canManageWorkspace("viewer")).toBe(false);
  });

  it("edit: owner + admin + editor", () => {
    expect(canEditProjects("owner")).toBe(true);
    expect(canEditProjects("admin")).toBe(true);
    expect(canEditProjects("editor")).toBe(true);
    expect(canEditProjects("viewer")).toBe(false);
  });
});
