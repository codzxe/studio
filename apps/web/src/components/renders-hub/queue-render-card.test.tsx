/**
 * QueueRenderCard tests (M8-J) — the hub queue entry: the compact card →
 * inline form (D-2: format options are ONLY the enabled two), the debounced
 * live estimate (stale-answer drop, honest typed-error copy), the queue
 * submit (fresh idempotencyKey per attempt, onQueued → list refresh) and
 * the typed queue failures with honest copy (insufficient credits → billing
 * link; concurrency/quota → friendly explanations).
 */

import { ApiError } from "@studio/api-client";
import type {
  EstimateResult,
  QueueRenderRequest,
  RenderEstimateRequest,
  RenderJob,
} from "@studio/contracts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  QUEUE_FORMAT_OPTIONS,
  QueueRenderCard,
  formatOutputSeconds,
  formatRenderCredits,
} from "./queue-render-card";
import type { HubCompOption, RendersHubPort } from "./renders-panel";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const COMPS: readonly HubCompOption[] = [
  { id: "cmp_main", name: "Main" },
  { id: "cmp_end", name: "End card" },
];

const ESTIMATE: EstimateResult = {
  credits: 14,
  outputSeconds: 30,
  longEdgePx: 1920,
  format: "mp4",
  quality: "good",
  minApplied: false,
};

function createdJob(overrides: Partial<RenderJob> = {}): RenderJob {
  return {
    id: "rnd_new",
    projectId: "prj_demo",
    compId: "cmp_main",
    versionId: "ver_demo_4",
    format: "mp4",
    settings: {},
    status: "queued",
    cancelRequested: false,
    progress: { framesDone: 0, framesTotal: 0, percent: 0 },
    credits: null,
    resultUrl: null,
    errorCode: null,
    error: null,
    sizeBytes: null,
    createdBy: "usr_demo",
    createdAt: "2026-10-21T16:00:00.000Z",
    startedAt: null,
    completedAt: null,
    expiresAt: null,
    ...overrides,
  };
}

type CardApi = Pick<RendersHubPort, "estimateRender" | "queueRender">;

function makeApi(overrides: Partial<CardApi> = {}): CardApi {
  return {
    estimateRender: vi.fn(async (_body: RenderEstimateRequest) => ESTIMATE),
    queueRender: vi.fn(async (body: QueueRenderRequest) => createdJob({ compId: body.compId })),
    ...overrides,
  };
}

interface CardOverrides {
  readonly api: CardApi;
  readonly comps: readonly HubCompOption[];
  readonly debounceMs: number | undefined;
  readonly onQueued: (job: RenderJob) => void;
  readonly topUpHref: string | undefined;
}

function renderCard(overrides: Partial<CardOverrides> = {}): CardApi {
  const api = overrides.api ?? makeApi();
  render(
    <QueueRenderCard
      projectId="prj_demo"
      comps={overrides.comps ?? COMPS}
      editorHref="/w/launch-film/editor"
      api={api}
      onQueued={overrides.onQueued ?? vi.fn()}
      debounceMs={overrides.debounceMs}
      topUpHref={overrides.topUpHref}
    />,
  );
  return api;
}

async function openForm(): Promise<void> {
  await userEvent.setup().click(screen.getByTestId("renders-hub-queue-button"));
}

// ---------------------------------------------------------------------------
// Pure formatters
// ---------------------------------------------------------------------------

describe("formatters", () => {
  it("credits display numbers (D-12): whole credits, up to 2 decimals, honest —", () => {
    expect(formatRenderCredits(14)).toBe("14");
    expect(formatRenderCredits(0.25)).toBe("0.25");
    expect(formatRenderCredits(1234.5)).toBe("1,234.5");
    expect(formatRenderCredits(null)).toBe("—");
    expect(formatRenderCredits(Number.NaN)).toBe("—");
  });

  it("output seconds: one decimal, honest —", () => {
    expect(formatOutputSeconds(30)).toBe("30s");
    expect(formatOutputSeconds(10.55)).toBe("10.6s");
    expect(formatOutputSeconds(-1)).toBe("—");
  });

  it("D-2 pin: the queue format options are ONLY mp4 and png-seq", () => {
    expect(QUEUE_FORMAT_OPTIONS).toHaveLength(2);
    expect(QUEUE_FORMAT_OPTIONS.map((option) => option.id)).toEqual(["mp4", "png-seq"]);
  });
});

// ---------------------------------------------------------------------------
// The card: composition + fields
// ---------------------------------------------------------------------------

describe("the card", () => {
  it("starts collapsed; the Render button opens the inline form and the estimate settles", async () => {
    const api = makeApi();
    renderCard({ api, debounceMs: 10 });
    expect(screen.queryByTestId("renders-hub-comp")).toBeNull();

    await openForm();
    expect(screen.getByTestId("renders-hub-comp")).toBeInTheDocument();
    await waitFor(() => {
      expect(api.estimateRender).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByTestId("renders-hub-estimate")).toHaveTextContent(
        "Estimated 14 credits · 30s · 1920px long edge",
      );
    });
    expect(screen.getByTestId("renders-hub-estimate")).toHaveAttribute("data-state", "ready");
  });

  it("D-2: the format picker offers exactly the two enabled formats", async () => {
    renderCard({ debounceMs: 10 });
    await openForm();
    const formatSelect = screen.getByTestId("renders-hub-format");
    const options = Array.from(formatSelect.querySelectorAll("option"));
    expect(options).toHaveLength(2);
    expect(options.map((option) => option.value)).toEqual(["mp4", "png-seq"]);
    expect(formatSelect).toHaveTextContent("MP4 — video");
    expect(formatSelect).toHaveTextContent("PNG sequence — frames");
    // The disabled formats are never offered (D-2 gate).
    expect(formatSelect).not.toHaveTextContent("ProRes");
    expect(formatSelect).not.toHaveTextContent("GIF");
  });

  it("the comp picker lists host comps; queueing uses the selected one", async () => {
    const api = makeApi();
    renderCard({ api, debounceMs: 10 });
    await openForm();
    const compSelect = screen.getByTestId("renders-hub-comp");
    expect(compSelect).toHaveTextContent("Main");
    expect(compSelect).toHaveTextContent("End card");

    await userEvent.setup().click(screen.getByTestId("renders-hub-queue-submit"));
    await waitFor(() => {
      expect(api.queueRender).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(api.queueRender).mock.calls[0]?.[0].compId).toBe("cmp_main");

    fireEvent.change(compSelect, { target: { value: "cmp_end" } });
    await waitFor(() => {
      expect(vi.mocked(api.estimateRender).mock.calls.at(-1)?.[0].compId).toBe("cmp_end");
    });
  });

  it("without any known comp the card stays honest and links to the editor", () => {
    renderCard({ comps: [] });
    expect(screen.getByTestId("renders-hub-queue-empty")).toHaveTextContent(
      "No composition to queue here yet.",
    );
    expect(screen.queryByTestId("renders-hub-queue-button")).toBeNull();
    expect(screen.getByTestId("renders-hub-queue-editor-link").getAttribute("href")).toBe(
      "/w/launch-film/editor",
    );
  });
});

// ---------------------------------------------------------------------------
// Estimate: debounce, body shape, error copy, range validation
// ---------------------------------------------------------------------------

describe("estimate", () => {
  it("debounces: three rapid changes coalesce into one call; the body carries the settings", async () => {
    const api = makeApi();
    renderCard({ api, debounceMs: 200 });
    await openForm();

    fireEvent.change(screen.getByTestId("renders-hub-quality"), { target: { value: "best" } });
    fireEvent.change(screen.getByTestId("renders-hub-quality"), { target: { value: "draft" } });
    fireEvent.change(screen.getByTestId("renders-hub-quality"), { target: { value: "best" } });
    await waitFor(() => {
      expect(screen.getByTestId("renders-hub-estimate")).toHaveAttribute("data-state", "ready");
    });
    expect(api.estimateRender).toHaveBeenCalledTimes(1);
    const body = vi.mocked(api.estimateRender).mock.calls[0]?.[0];
    expect(body?.projectId).toBe("prj_demo");
    expect(body?.compId).toBe("cmp_main");
    expect(body?.format).toBe("mp4");
    expect(body?.settings.quality).toBe("best");
    expect(body?.settings.width).toBe(1920);
    expect(body?.settings.height).toBe(1080);
    expect(body?.settings.frameRate).toBe(24);
    expect(body?.settings.timeFrom).toBeUndefined();
    expect(body?.settings.timeTo).toBeUndefined();
  });

  it("resolution + fps + range ride the settings; minApplied appends its note", async () => {
    const api = makeApi({
      estimateRender: vi.fn(async () => ({ ...ESTIMATE, minApplied: true, credits: 0.25 })),
    });
    renderCard({ api, debounceMs: 10 });
    await openForm();
    fireEvent.change(screen.getByTestId("renders-hub-resolution"), {
      target: { value: "1080x1920" },
    });
    fireEvent.change(screen.getByTestId("renders-hub-fps"), { target: { value: "30" } });
    fireEvent.change(screen.getByTestId("renders-hub-range-from"), { target: { value: "2" } });
    fireEvent.change(screen.getByTestId("renders-hub-range-to"), { target: { value: "12.5" } });

    // RACE-PROOF (CI run 41338366639): on a slow runner the form's OPEN
    // estimate (default settings) fires before these changes land — calls[0]
    // is then the STALE call and `toHaveBeenCalledTimes(1)` passes early.
    // The component's cleanup chain guarantees the LAST scheduled timer
    // carries the LAST built settings, so assert the LAST call.
    await waitFor(() => {
      const last = vi.mocked(api.estimateRender).mock.calls.at(-1)?.[0];
      expect(last?.settings?.width).toBe(1080);
      expect(last?.settings?.height).toBe(1920);
      expect(last?.settings?.frameRate).toBe(30);
      expect(last?.settings?.timeFrom).toBe(2);
      expect(last?.settings?.timeTo).toBe(12.5);
    });

    await waitFor(() => {
      expect(screen.getByTestId("renders-hub-estimate")).toHaveTextContent(
        "Estimated 0.25 credits · 30s · 1920px long edge · platform minimum applied",
      );
    });
  });

  it("an inverted range explains itself client-side and blocks the estimate and the submit", async () => {
    const api = makeApi();
    renderCard({ api, debounceMs: 10 });
    await openForm();
    fireEvent.change(screen.getByTestId("renders-hub-range-from"), { target: { value: "10" } });
    fireEvent.change(screen.getByTestId("renders-hub-range-to"), { target: { value: "5" } });

    await waitFor(() => {
      expect(screen.getByTestId("renders-hub-estimate")).toHaveTextContent(
        "The range end must come after its start.",
      );
    });
    expect(api.estimateRender).not.toHaveBeenCalled();
    expect(screen.getByTestId("renders-hub-queue-submit")).toBeDisabled();
  });

  it("surfaces typed estimate failures with honest copy", async () => {
    const api = makeApi({
      estimateRender: vi.fn(async () => {
        throw new ApiError({
          code: "VALIDATION_FAILED",
          message: "timeTo must be >= timeFrom",
          status: 400,
          requestId: "req_es_01",
        });
      }),
    });
    renderCard({ api, debounceMs: 10 });
    await openForm();
    await waitFor(() => {
      expect(screen.getByTestId("renders-hub-estimate")).toHaveAttribute("data-state", "error");
    });
    expect(screen.getByTestId("renders-hub-estimate")).toHaveTextContent(
      "These settings can't be estimated — check the range and resolution.",
    );
  });
});

// ---------------------------------------------------------------------------
// Queue: success, fresh idempotency keys, typed failures
// ---------------------------------------------------------------------------

describe("queue", () => {
  it("queues with a fresh idempotencyKey per attempt and hands the job to onQueued", async () => {
    const onQueued = vi.fn();
    const api = makeApi();
    renderCard({ api, debounceMs: 10, onQueued });

    await openForm();
    const submit = screen.getByTestId("renders-hub-queue-submit");
    await userEvent.setup().click(submit);
    await waitFor(() => {
      expect(api.queueRender).toHaveBeenCalledTimes(1);
    });
    const first = vi.mocked(api.queueRender).mock.calls[0]?.[0];
    expect(first?.idempotencyKey).toMatch(/^[\da-f-]{36}$/);
    await waitFor(() => {
      expect(onQueued).toHaveBeenCalledTimes(1);
    });
    expect(onQueued).toHaveBeenCalledWith(createdJob());
    expect(screen.getByTestId("renders-hub-queue-note")).toHaveTextContent(
      "Render queued — watch its progress below.",
    );

    await userEvent.setup().click(submit);
    await waitFor(() => {
      expect(api.queueRender).toHaveBeenCalledTimes(2);
    });
    const second = vi.mocked(api.queueRender).mock.calls[1]?.[0];
    expect(second?.idempotencyKey).not.toBe(first?.idempotencyKey);
  });

  it("insufficient credits → the typed message plus the billing top-up link", async () => {
    const api = makeApi({
      queueRender: vi.fn(async () => {
        throw new ApiError({
          code: "INSUFFICIENT_CREDITS",
          message: "You need 14 credits for this render; 3 remain.",
          status: 402,
          requestId: "req_cr_01",
        });
      }),
    });
    renderCard({ api, debounceMs: 10 });
    await openForm();
    await userEvent.setup().click(screen.getByTestId("renders-hub-queue-submit"));
    await waitFor(() => {
      expect(screen.getByTestId("renders-hub-queue-error")).toHaveTextContent(
        "You need 14 credits for this render; 3 remain.",
      );
    });
    expect(screen.getByTestId("renders-hub-queue-error")).toHaveTextContent("req_cr_01");
    expect(screen.getByTestId("renders-hub-queue-topup").getAttribute("href")).toBe("/w/billing");
  });

  it("concurrency limit → the friendly plan-boundary explanation, no billing link", async () => {
    const api = makeApi({
      queueRender: vi.fn(async () => {
        throw new ApiError({
          code: "RENDER_CONCURRENCY_LIMIT",
          message: "Too many concurrent renders.",
          status: 429,
        });
      }),
    });
    renderCard({ api, debounceMs: 10 });
    await openForm();
    await userEvent.setup().click(screen.getByTestId("renders-hub-queue-submit"));
    await waitFor(() => {
      expect(screen.getByTestId("renders-hub-queue-error")).toHaveTextContent(
        "You're already running the maximum number of renders for your plan.",
      );
    });
    expect(screen.getByTestId("renders-hub-queue-error")).toHaveTextContent(
      "Wait for one to finish, then queue this one again.",
    );
    expect(screen.queryByTestId("renders-hub-queue-topup")).toBeNull();
  });

  it("quota exceeded → the monthly render-minutes explanation plus the billing link", async () => {
    const api = makeApi({
      queueRender: vi.fn(async () => {
        throw new ApiError({
          code: "RENDER_QUOTA_EXCEEDED",
          message: "Monthly render minutes exhausted.",
          status: 429,
        });
      }),
    });
    renderCard({ api, debounceMs: 10, topUpHref: "/w/billing?plan=1" });
    await openForm();
    await userEvent.setup().click(screen.getByTestId("renders-hub-queue-submit"));
    await waitFor(() => {
      expect(screen.getByTestId("renders-hub-queue-error")).toHaveTextContent(
        "This render would go past your plan's monthly render minutes.",
      );
    });
    expect(screen.getByTestId("renders-hub-queue-topup").getAttribute("href")).toBe(
      "/w/billing?plan=1",
    );
  });

  it("any other typed failure renders the §14 message + hint + request id", async () => {
    const api = makeApi({
      queueRender: vi.fn(async () => {
        throw new ApiError({
          code: "LEASE_HELD",
          message: "Sam is editing this project right now.",
          hint: "Queue again once the edit lease is free.",
          status: 409,
          requestId: "req_q_01",
        });
      }),
    });
    renderCard({ api, debounceMs: 10 });
    await openForm();
    await userEvent.setup().click(screen.getByTestId("renders-hub-queue-submit"));
    await waitFor(() => {
      expect(screen.getByTestId("renders-hub-queue-error")).toHaveTextContent(
        "Sam is editing this project right now.",
      );
    });
    expect(screen.getByTestId("renders-hub-queue-error")).toHaveTextContent("req_q_01");
    expect(screen.getByTestId("renders-hub-queue-error")).toHaveTextContent(
      "Queue again once the edit lease is free.",
    );
    expect(screen.queryByTestId("renders-hub-queue-topup")).toBeNull();
  });
});
