import { describe, expect, it } from "vitest";

import { ok } from "../src/envelope.js";
import { PLAN_ID_SCHEMA } from "../src/models.js";
import {
  ACQUIRE_LEASE_SCHEMA,
  CANCEL_RUN_SCHEMA,
  CHAT_REQUEST_SCHEMA,
  CHECKOUT_SCHEMA,
  COMMENTS_QUERY_SCHEMA,
  COMMENT_REPLY_SCHEMA,
  CONTEXT_SELECTION_SCHEMA,
  CREATE_ASSET_SCHEMA,
  CREATE_COMMENT_SCHEMA,
  CREATE_PROJECT_SCHEMA,
  CREATE_THREAD_SCHEMA,
  CREATE_WORKSPACE_SCHEMA,
  GUEST_COMMENT_SCHEMA,
  IDEMPOTENCY_KEY_SCHEMA,
  INVITE_MEMBER_SCHEMA,
  LEASE_TTL_MS,
  LEDGER_KIND_SCHEMA,
  PAGINATION_QUERY_SCHEMA,
  PATCH_PROJECT_SCHEMA,
  PATCH_WORKSPACE_SCHEMA,
  PINNED_CONTEXT_ITEM_SCHEMA,
  PORTAL_SCHEMA,
  QUEUE_RENDER_SCHEMA,
  RESOLVE_COMMENT_SCHEMA,
  RESTORE_VERSION_SCHEMA,
  ROLE_SCHEMA,
  RUN_EVENT_REQUEST_SCHEMA,
  SET_VERSION_LABEL_SCHEMA,
  TOPUP_SCHEMA,
  UPLOAD_VERSION_SCHEMA,
} from "../src/routes/index.js";
import type {
  Asset,
  Comment,
  LedgerEntry,
  ProjectManifest,
  RunRecord,
  SignedUrlResponse,
  ThreadMessage,
} from "../src/routes/index.js";

const SHA = "a".repeat(64);

describe("routes: workspaces + invites", () => {
  it("create/patch workspace", () => {
    expect(CREATE_WORKSPACE_SCHEMA.safeParse({ name: "Acme", slug: "acme" }).success).toBe(true);
    expect(CREATE_WORKSPACE_SCHEMA.safeParse({ name: "Acme", slug: "Acme" }).success).toBe(false);
    expect(CREATE_WORKSPACE_SCHEMA.safeParse({ name: "Acme", slug: "-bad-" }).success).toBe(false);
    expect(CREATE_WORKSPACE_SCHEMA.safeParse({ name: "Acme" }).success).toBe(false);
    expect(
      CREATE_WORKSPACE_SCHEMA.safeParse({ name: "Acme", slug: "acme", extra: 1 }).success,
    ).toBe(false);
    expect(PATCH_WORKSPACE_SCHEMA.safeParse({ name: "New" }).success).toBe(true);
    expect(PATCH_WORKSPACE_SCHEMA.safeParse({}).success).toBe(false); // empty patch rejected
  });

  it("invite member: email + wire-stable role", () => {
    expect(INVITE_MEMBER_SCHEMA.safeParse({ email: "a@b.co", role: "editor" }).success).toBe(true);
    expect(INVITE_MEMBER_SCHEMA.safeParse({ email: "not-an-email", role: "editor" }).success).toBe(
      false,
    );
    expect(INVITE_MEMBER_SCHEMA.safeParse({ email: "a@b.co", role: "superuser" }).success).toBe(
      false,
    );
    expect(ROLE_SCHEMA.options).toEqual(["owner", "admin", "editor", "viewer"]);
  });
});

describe("routes: projects + versions", () => {
  it("create/patch project", () => {
    expect(CREATE_PROJECT_SCHEMA.safeParse({ name: "Launch reel" }).success).toBe(true);
    expect(
      CREATE_PROJECT_SCHEMA.safeParse({ name: "Launch reel", description: "Q3" }).success,
    ).toBe(true);
    expect(CREATE_PROJECT_SCHEMA.safeParse({ name: "" }).success).toBe(false);
    expect(PATCH_PROJECT_SCHEMA.safeParse({ description: "new" }).success).toBe(true);
    expect(PATCH_PROJECT_SCHEMA.safeParse({}).success).toBe(false);
  });

  it("upload version descriptor: base + sha256 + optional label/agentRunId", () => {
    const valid = {
      baseVersionId: "v1",
      sha256: SHA,
      sizeBytes: 4096,
      label: "Agent: build kinetic title",
      agentRunId: "run_1",
    };
    expect(UPLOAD_VERSION_SCHEMA.safeParse(valid).success).toBe(true);
    expect(UPLOAD_VERSION_SCHEMA.safeParse({ ...valid, sha256: "zz" }).success).toBe(false);
    expect(UPLOAD_VERSION_SCHEMA.safeParse({ sha256: SHA, sizeBytes: 1 }).success).toBe(false);
    expect(UPLOAD_VERSION_SCHEMA.safeParse({ ...valid, agentRunId: "" }).success).toBe(false);
    // M7 task 4: confirm-with-confirmation — a restore must carry the typed
    // confirmation label; a bare (or note-only) restore is invalid.
    expect(RESTORE_VERSION_SCHEMA.safeParse({ confirmLabel: "v3" }).success).toBe(true);
    expect(
      RESTORE_VERSION_SCHEMA.safeParse({ confirmLabel: "v3", note: "back to v3" }).success,
    ).toBe(true);
    expect(RESTORE_VERSION_SCHEMA.safeParse({ note: "back to v3" }).success).toBe(false);
    expect(RESTORE_VERSION_SCHEMA.safeParse({ confirmLabel: "" }).success).toBe(false);
    expect(RESTORE_VERSION_SCHEMA.safeParse({}).success).toBe(false);
    // Labels are the ONLY mutable version field (§9.3; D-24 candidate).
    expect(SET_VERSION_LABEL_SCHEMA.safeParse({ label: "shipped cut" }).success).toBe(true);
    expect(SET_VERSION_LABEL_SCHEMA.safeParse({ label: "" }).success).toBe(false);
    expect(SET_VERSION_LABEL_SCHEMA.safeParse({ label: "x".repeat(121) }).success).toBe(false);
    expect(SET_VERSION_LABEL_SCHEMA.safeParse({}).success).toBe(false);
  });
});

describe("routes: leases (§9.1, §11)", () => {
  it("acquire/renew requires a session id; constants match §11", () => {
    expect(ACQUIRE_LEASE_SCHEMA.safeParse({ sessionId: "session-123" }).success).toBe(true);
    expect(ACQUIRE_LEASE_SCHEMA.safeParse({}).success).toBe(false);
    expect(LEASE_TTL_MS).toBe(300_000);
  });
});

describe("routes: assets", () => {
  it("create descriptor: name/mime/size/sha256, optional dimensions", () => {
    const valid = {
      name: "logo.png",
      mime: "image/png",
      sizeBytes: 1024,
      sha256: SHA,
      width: 512,
      height: 512,
    };
    expect(CREATE_ASSET_SCHEMA.safeParse(valid).success).toBe(true);
    expect(CREATE_ASSET_SCHEMA.safeParse({ ...valid, sizeBytes: 0 }).success).toBe(false);
    expect(CREATE_ASSET_SCHEMA.safeParse({ ...valid, mime: "not a mime" }).success).toBe(false);
    expect(
      CREATE_ASSET_SCHEMA.safeParse({ name: "x", mime: "image/png", sizeBytes: 1, sha256: SHA })
        .success,
    ).toBe(true);
  });

  it("response types compile (asset + signed url)", () => {
    const asset: Asset = {
      id: "a1",
      workspaceId: "w1",
      projectId: null,
      name: "logo.png",
      mime: "image/png",
      sizeBytes: 1024,
      sha256: SHA,
      width: 512,
      height: 512,
      durationTicks: null,
      createdBy: "u1",
      createdAt: "2026-01-01T00:00:00Z",
    };
    const signed: SignedUrlResponse = {
      url: "https://example.test/get",
      expiresAt: "2026-01-01T00:05:00Z",
    };
    expect(ok({ asset, signed }).data.asset.name).toBe("logo.png");
  });
});

describe("routes: threads + chat (EDITOR_CHAT_UX §5)", () => {
  it("thread create accepts an optional title", () => {
    expect(CREATE_THREAD_SCHEMA.safeParse({ title: "Fix intro" }).success).toBe(true);
    expect(CREATE_THREAD_SCHEMA.safeParse({}).success).toBe(true);
  });

  it("ContextSelection: always-on blocks default true, conditional default false", () => {
    const parsed = CONTEXT_SELECTION_SCHEMA.parse({});
    expect(parsed).toEqual({
      projectSummary: true,
      activeComp: true,
      selection: false,
      playhead: true,
      focusedPanel: true,
      selectedProperties: false,
      currentFrame: false,
      recentCommands: false,
      comments: false,
    });
    expect(CONTEXT_SELECTION_SCHEMA.safeParse({ comments: true }).success).toBe(true);
    expect(CONTEXT_SELECTION_SCHEMA.safeParse({ projectSummary: "yes" }).success).toBe(false);
    expect(CONTEXT_SELECTION_SCHEMA.safeParse({ unknownBlock: true }).success).toBe(false); // strict
  });

  it("pinned context items: 5 kinds, label required, id optional", () => {
    expect(
      PINNED_CONTEXT_ITEM_SCHEMA.safeParse({ kind: "frame", label: "00:00:03:12" }).success,
    ).toBe(true);
    expect(
      PINNED_CONTEXT_ITEM_SCHEMA.safeParse({ kind: "asset", id: "a1", label: "logo.png" }).success,
    ).toBe(true);
    expect(PINNED_CONTEXT_ITEM_SCHEMA.safeParse({ kind: "cursor", label: "x" }).success).toBe(
      false,
    );
    expect(PINNED_CONTEXT_ITEM_SCHEMA.safeParse({ kind: "frame" }).success).toBe(false);
  });

  it("chat request: message + context + idempotencyKey", () => {
    const valid = { message: "make the headline pop", context: {}, idempotencyKey: "key-1234" };
    expect(CHAT_REQUEST_SCHEMA.safeParse(valid).success).toBe(true);
    expect(CHAT_REQUEST_SCHEMA.safeParse({ ...valid, idempotencyKey: "short" }).success).toBe(
      false,
    );
    expect(CHAT_REQUEST_SCHEMA.safeParse({ ...valid, message: "" }).success).toBe(false);
    expect(CHAT_REQUEST_SCHEMA.safeParse({ message: "x", context: {} }).success).toBe(false);
    // pinned defaults to an empty list
    expect(CHAT_REQUEST_SCHEMA.parse(valid).pinned).toEqual([]);
    expect(IDEMPOTENCY_KEY_SCHEMA.safeParse("key-1234").success).toBe(true);
  });

  it("thread message response type compiles", () => {
    const message: ThreadMessage = {
      id: "m1",
      threadId: "t1",
      role: "assistant",
      content: { parts: [] },
      runId: null,
      createdAt: "2026-01-01T00:00:00Z",
    };
    expect(message.role).toBe("assistant");
  });
});

describe("routes: runs (§7.2 runs endpoints)", () => {
  it("tool.result events carry the expected toolCallId", () => {
    expect(
      RUN_EVENT_REQUEST_SCHEMA.safeParse({ type: "tool.result", toolCallId: "t1", result: {} })
        .success,
    ).toBe(true);
    expect(
      RUN_EVENT_REQUEST_SCHEMA.safeParse({ type: "tool.result", toolCallId: "", result: {} })
        .success,
    ).toBe(false);
  });

  it("apply.result: sha256 on success, errorCode on failure", () => {
    expect(
      RUN_EVENT_REQUEST_SCHEMA.safeParse({ type: "apply.result", ok: true, sha256: SHA }).success,
    ).toBe(true);
    expect(RUN_EVENT_REQUEST_SCHEMA.safeParse({ type: "apply.result", ok: true }).success).toBe(
      false,
    );
    expect(
      RUN_EVENT_REQUEST_SCHEMA.safeParse({
        type: "apply.result",
        ok: false,
        errorCode: "RUN_BATCH_ROLLED_BACK",
      }).success,
    ).toBe(true);
    expect(RUN_EVENT_REQUEST_SCHEMA.safeParse({ type: "apply.result", ok: false }).success).toBe(
      false,
    );
    expect(RUN_EVENT_REQUEST_SCHEMA.safeParse({ type: "nope" }).success).toBe(false);
  });

  it("cancel accepts an optional reason", () => {
    expect(CANCEL_RUN_SCHEMA.safeParse({}).success).toBe(true);
    expect(CANCEL_RUN_SCHEMA.safeParse({ reason: "wrong layer" }).success).toBe(true);
  });

  it("run record response type compiles", () => {
    const run: RunRecord = {
      id: "r1",
      threadId: "t1",
      projectId: "p1",
      model: "studio-smart",
      status: "completed",
      plan: null,
      steps: [{ seq: 1, tool: "studio.get_context", status: "succeeded", durationMs: 200 }],
      reservedCredits: 2.4,
      committedCredits: 1.8,
      baseVersionId: "v1",
      resultVersionId: "v2",
      errorCode: null,
      createdAt: "2026-01-01T00:00:00Z",
      completedAt: "2026-01-01T00:00:10Z",
    };
    expect(run.status).toBe("completed");
  });
});

describe("routes: credits + billing", () => {
  it("ledger kinds are the §9.1 five", () => {
    expect(LEDGER_KIND_SCHEMA.options).toEqual(["grant", "reserve", "commit", "refund", "adjust"]);
    const entry: LedgerEntry = {
      id: "l1",
      workspaceId: "w1",
      kind: "commit",
      amount: -1.8,
      balanceAfter: 98.2,
      runId: "r1",
      idempotencyKey: "key-1234",
      metadata: {},
      createdAt: "2026-01-01T00:00:00Z",
    };
    expect(entry.kind).toBe("commit");
  });

  it("checkout: planId (paid only); top-up packs are their own wire", () => {
    expect(CHECKOUT_SCHEMA.safeParse({ planId: "pro" }).success).toBe(true);
    // M6-C split the wire: pack purchases moved to POST /v1/billing/topup.
    expect(CHECKOUT_SCHEMA.safeParse({ packId: "credits-1000" }).success).toBe(false);
    expect(TOPUP_SCHEMA.safeParse({ packId: "credits100" }).success).toBe(true);
    expect(TOPUP_SCHEMA.safeParse({ packId: "credits-1000" }).success).toBe(false);
    expect(TOPUP_SCHEMA.safeParse({ packId: "credits100", planId: "pro" }).success).toBe(false);
    expect(CHECKOUT_SCHEMA.safeParse({}).success).toBe(false);
    expect(CHECKOUT_SCHEMA.safeParse({ planId: "trial" }).success).toBe(false); // trial never purchased
    expect(PLAN_ID_SCHEMA.options).toEqual(["trial", "starter", "pro", "studio"]);
  });

  it("portal: optional returnUrl", () => {
    expect(PORTAL_SCHEMA.safeParse({}).success).toBe(true);
    expect(PORTAL_SCHEMA.safeParse({ returnUrl: "https://app.example.test/billing" }).success).toBe(
      true,
    );
    expect(PORTAL_SCHEMA.safeParse({ returnUrl: "not-a-url" }).success).toBe(false);
  });
});

describe("routes: renders", () => {
  it("queue render: 5 §7.2 formats, settings validated, idempotent", () => {
    const valid = {
      projectId: "p1",
      compId: "c1",
      format: "mp4",
      settings: { timeFrom: 0, timeTo: 5, quality: "good" },
      idempotencyKey: "render-1234",
    };
    expect(QUEUE_RENDER_SCHEMA.safeParse(valid).success).toBe(true);
    expect(QUEUE_RENDER_SCHEMA.safeParse({ ...valid, format: "avi" }).success).toBe(false);
    expect(
      QUEUE_RENDER_SCHEMA.safeParse({ ...valid, settings: { timeFrom: 5, timeTo: 0 } }).success,
    ).toBe(false);
    expect(QUEUE_RENDER_SCHEMA.safeParse({ ...valid, settings: { unknown: true } }).success).toBe(
      false,
    );
    expect(QUEUE_RENDER_SCHEMA.safeParse({ ...valid, idempotencyKey: "" }).success).toBe(false);
  });
});

describe("routes: comments + activity", () => {
  it("create comment: comp anchor required, body bounded", () => {
    const valid = { compId: "c1", layerId: "l1", timeTicks: 120, body: "Tighten this" };
    expect(CREATE_COMMENT_SCHEMA.safeParse(valid).success).toBe(true);
    expect(CREATE_COMMENT_SCHEMA.safeParse({ ...valid, compId: undefined }).success).toBe(false);
    expect(CREATE_COMMENT_SCHEMA.safeParse({ compId: "c1", body: "" }).success).toBe(false);
    expect(RESOLVE_COMMENT_SCHEMA.safeParse({ resolved: true }).success).toBe(true);
    expect(RESOLVE_COMMENT_SCHEMA.safeParse({}).success).toBe(true);
    expect(RESOLVE_COMMENT_SCHEMA.parse({}).resolved).toBe(true); // empty body resolves
    expect(RESOLVE_COMMENT_SCHEMA.parse({ resolved: false }).resolved).toBe(false);
    expect(RESOLVE_COMMENT_SCHEMA.safeParse({ resolved: "yes" }).success).toBe(false);
    expect(COMMENTS_QUERY_SCHEMA.safeParse({ limit: 50, resolved: true }).success).toBe(true);
    expect(COMMENTS_QUERY_SCHEMA.safeParse({ limit: 50, resolved: "true" }).success).toBe(true); // query-string booleans
    expect(COMMENTS_QUERY_SCHEMA.parse({ limit: 50, resolved: "false" }).resolved).toBe(false);
    const comment: Comment = {
      id: "c1",
      projectId: "p1",
      compId: "comp1",
      layerId: null,
      timeTicks: null,
      parentCommentId: null,
      body: "Tighten this",
      authorId: "u1",
      guestName: null,
      guestEmail: null,
      resolvedAt: null,
      resolvedBy: null,
      createdAt: "2026-01-01T00:00:00Z",
    };
    expect(comment.resolvedAt).toBeNull();
  });

  it("reply/guest bodies: bounded, strict, guest identity shaped", () => {
    expect(COMMENT_REPLY_SCHEMA.safeParse({ body: "agreed" }).success).toBe(true);
    expect(COMMENT_REPLY_SCHEMA.safeParse({ body: "x".repeat(2001) }).success).toBe(false);
    expect(COMMENT_REPLY_SCHEMA.safeParse({ body: "agreed", compId: "c1" }).success).toBe(false); // anchor is inherited, not sent

    const guest = {
      compId: "c1",
      body: "From a client: the logo drifts",
      guestName: "Alex Guest",
      guestEmail: "alex@client.test",
    };
    expect(GUEST_COMMENT_SCHEMA.safeParse(guest).success).toBe(true);
    expect(GUEST_COMMENT_SCHEMA.safeParse({ ...guest, guestName: "" }).success).toBe(false);
    expect(GUEST_COMMENT_SCHEMA.safeParse({ ...guest, guestName: "x".repeat(81) }).success).toBe(
      false,
    );
    expect(GUEST_COMMENT_SCHEMA.safeParse({ ...guest, guestEmail: "x".repeat(201) }).success).toBe(
      false,
    );
    expect(GUEST_COMMENT_SCHEMA.safeParse({ ...guest, guestEmail: "not-an-email" }).success).toBe(
      false,
    );
    expect(GUEST_COMMENT_SCHEMA.safeParse({ ...guest, authorId: "u1" }).success).toBe(false); // no author rides guest input
  });

  it("pagination: limit ≤ 100, defaults to 50, cursor optional", () => {
    expect(PAGINATION_QUERY_SCHEMA.safeParse({}).success).toBe(true);
    expect(PAGINATION_QUERY_SCHEMA.parse({}).limit).toBe(50);
    expect(PAGINATION_QUERY_SCHEMA.parse({ limit: "25" }).limit).toBe(25); // query strings coerce
    expect(PAGINATION_QUERY_SCHEMA.safeParse({ limit: 101 }).success).toBe(false);
    expect(PAGINATION_QUERY_SCHEMA.safeParse({ limit: 0 }).success).toBe(false);
    expect(PAGINATION_QUERY_SCHEMA.parse({ cursor: "abc" }).cursor).toBe("abc");
    expect(PAGINATION_QUERY_SCHEMA.safeParse({ limit: 50.5 }).success).toBe(false);
  });

  it("manifest response type compiles", () => {
    const manifest: ProjectManifest = {
      projectId: "p1",
      currentVersion: {
        id: "v2",
        version: 12,
        sha256: SHA,
        label: null,
        sizeBytes: 2048,
        createdAt: "2026-01-01T00:00:00Z",
        url: "https://example.test/v2",
      },
      assets: [
        {
          id: "a1",
          name: "logo.png",
          mime: "image/png",
          sizeBytes: 512,
          width: 128,
          height: 128,
          durationTicks: null,
          url: "https://example.test/a1",
        },
      ],
      updatedAt: "2026-01-01T00:00:00Z",
    };
    expect(manifest.currentVersion?.version).toBe(12);
  });
});
