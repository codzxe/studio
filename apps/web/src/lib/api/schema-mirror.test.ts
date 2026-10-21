/**
 * Golden-fixture tests for the coarse §13 wire mirrors (W8-O) — the CI
 * tripwire for contract drift until the openapi-diff job exists (see the
 * schema-mirror.ts header TODO). Deterministic, no network.
 */
import { describe, expect, it } from "vitest";
import {
  componentCardSchema,
  creditsSchema,
  documentCardSchema,
  documentDetailEnvelopeSchema,
  documentListEnvelopeSchema,
  RUN_STATUSES,
  runCardSchema,
  runStatusPayloadSchema,
  templateCardSchema,
} from "./schema-mirror";

const DOCUMENT_CARD = {
  id: "doc_018f",
  name: "Spring Flyer",
  width_px: 1080,
  height_px: 1350,
  current_revision: 4,
  template_id: "instagram-post@3",
  created_by: "user_1",
  created_at: "2026-07-01T09:00:00Z",
  updated_at: "2026-07-04T12:30:00Z",
  archived_at: null,
};

describe("document mirrors", () => {
  it("parses a document card and strips unknown growth fields", () => {
    const parsed = documentCardSchema.parse({ ...DOCUMENT_CARD, future_field: 1 });
    expect(parsed.id).toBe("doc_018f");
    expect(parsed).not.toHaveProperty("future_field");
  });

  it("rejects a drifted card (wrong types are a typed error, never a guess)", () => {
    expect(documentCardSchema.safeParse({ ...DOCUMENT_CARD, width_px: "big" }).success).toBe(
      false,
    );
    expect(documentCardSchema.safeParse({ name: "no id" }).success).toBe(false);
  });

  it("parses the list envelope (ok + cursor page) and detail (+latest_version)", () => {
    const list = documentListEnvelopeSchema.parse({
      ok: true,
      documents: [DOCUMENT_CARD],
      next_cursor: "cursor_1",
    });
    expect(list.documents[0]?.id).toBe("doc_018f");
    const detail = documentDetailEnvelopeSchema.parse({
      ok: true,
      document: {
        ...DOCUMENT_CARD,
        latest_version: {
          id: "ver_9",
          revision: 4,
          label: "r4",
          created_by: "user_1",
          created_at: "2026-07-04T12:30:00Z",
        },
      },
    });
    expect(detail.document.latest_version?.revision).toBe(4);
  });
});

describe("run status mirror", () => {
  const RUN_CARD = {
    run_id: "run_018f",
    document_id: "doc_018f",
    status: "rendering",
    tier: "standard",
    revision_before: 3,
    revision_after: null,
    created_at: "2026-07-04T12:00:00Z",
    started_at: "2026-07-04T12:00:02Z",
    finished_at: null,
    error: null,
    credits: { reserved: 2, charged: 0 },
  };

  it("pins the gateway lifecycle enum", () => {
    expect(RUN_STATUSES).toContain("succeeded_with_warnings");
    expect(RUN_STATUSES).toHaveLength(13);
  });

  it("parses list cards and rejects unknown statuses", () => {
    expect(runCardSchema.parse(RUN_CARD).status).toBe("rendering");
    expect(runCardSchema.safeParse({ ...RUN_CARD, status: "exploded" }).success).toBe(false);
  });

  it("accepts the detail payload's plan/steps/cost extras", () => {
    const parsed = runStatusPayloadSchema.parse({
      ...RUN_CARD,
      status: "succeeded",
      plan: { steps: [] },
      steps: [],
      cost: { reserved: 2, charged: 1 },
    });
    expect(parsed.status).toBe("succeeded");
  });
});

describe("credits mirror", () => {
  it("accepts both the bare and ok-wrapped provisional shapes (audit D2)", () => {
    expect(creditsSchema.parse({ balance: 42 }).balance).toBe(42);
    expect(creditsSchema.parse({ ok: true, balance: 7 }).balance).toBe(7);
    expect(creditsSchema.safeParse({ balance: "many" }).success).toBe(false);
  });
});

describe("catalog card mirrors", () => {
  it("parses a §7.4 template discovery card", () => {
    const card = templateCardSchema.parse({
      id: "instagram-post",
      version: 3,
      ref: "instagram-post@3",
      name: "Instagram Post — Promo",
      tags: ["social", "promo"],
      canvas: { width: 1080, height: 1080 },
      slots: ["headline", "photo"],
    });
    expect(card.ref).toBe("instagram-post@3");
  });

  it("parses a §8.3 component discovery card", () => {
    const card = componentCardSchema.parse({
      id: "offer-badge",
      version: 2,
      ref: "offer-badge@2",
      name: "Offer Badge",
      tags: ["badge"],
      defaultSize: { width: 480, height: 240 },
      license: "MIT-0",
      variables: ["label"],
      comps: [],
    });
    expect(card.defaultSize.width).toBe(480);
  });
});
