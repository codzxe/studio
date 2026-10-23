/**
 * BillingPageView tests (M6-F) — the /w/billing client surface and its
 * COMPOSITION of the billing kit (M6-G: TopUpFlow / UpgradeCta /
 * LowCreditBanner / LedgerTable, whose own unit tests pin their internals —
 * these tests pin the page's WIRING):
 *
 * - §8.8 sections: plan card (status matrix incl. trial/grace/past-due/
 *   unknown), credits (D-12 µc→credits), payment, invoices, cancel;
 * - seat usage; the D-4 pricing strip (exactly starter/pro/studio, catalog
 *   placeholders, current-plan badge);
 * - the checkout arms: hosted URL redirect vs `planChanged` in-place state
 *   refresh; typed failure surfaces;
 * - the top-up seam (pack → confirm → POST → redirect);
 * - the ledger fetcher (mount page + cursor load-more);
 * - the usage section (W2-08/W3-H): the Usage card sits between Credits and
 *   Payment, its credits meter reads the SHARED ledger page, and renders
 *   fetch through the port's renders read;
 * - read-only members and the tokens-only style law. The api-client port is
 *   faked; jsdom (redirects captured through a location stub).
 */

import { ApiError } from "@studio/api-client";
import type {
  BillingState,
  CheckoutResponse,
  LedgerEntry,
  Page,
  PortalResponse,
  RenderJob,
  TopUpResponse,
} from "@studio/contracts";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Mock, afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type BillingInvoiceRow,
  BillingPageView,
  type BillingPageViewProps,
} from "./page-billing-view";

// ---------------------------------------------------------------------------
// Redirect seam: jsdom cannot navigate — replace `location` with a stub that
// records `assign` calls (the original is restored after the suite).
// ---------------------------------------------------------------------------

const assignMock = vi.fn();
const locationStub = {
  assign: (...args: unknown[]) => assignMock(...args),
  origin: "http://localhost:3000",
};
const originalLocation = window.location;
beforeAll(() => {
  Object.defineProperty(window, "location", { configurable: true, value: locationStub });
});
afterAll(() => {
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
});

// ---------------------------------------------------------------------------
// Fixtures (the real §7.2 wire shapes)
// ---------------------------------------------------------------------------

const NOW_ISO = "2026-10-21T12:00:00Z";

const PRO_STATE: BillingState = {
  plan: "pro",
  status: "active",
  currentPeriodEnd: "2026-11-01T00:00:00Z",
  trialEnd: null,
  cancelAtPeriodEnd: false,
  graceEnd: null,
  entitlements: {
    seats: 5,
    models: ["studio-fast", "studio-smart"],
    maxProjects: 50,
    storageBytes: 200 * 1024 ** 3,
    renderMinutesPerMonth: 600,
    monthlyCreditAllowance: 2_000_000_000,
  },
  credits: { balance: 12_345_678, reserved: 250_000 },
  topUpPacks: [
    { packId: "credits100", credits: 100 },
    { packId: "credits500", credits: 500 },
    { packId: "credits2000", credits: 2000 },
  ],
};

const TRIAL_STATE: BillingState = {
  ...PRO_STATE,
  plan: "trial",
  status: "trialing",
  trialEnd: "2026-11-03T12:00:00Z",
  currentPeriodEnd: "2026-11-04T12:00:00Z",
  entitlements: {
    seats: 1,
    models: ["studio-fast"],
    maxProjects: 3,
    storageBytes: 1024 ** 3,
    renderMinutesPerMonth: 5,
    monthlyCreditAllowance: 50_000_000,
  },
  credits: { balance: 40_000_000, reserved: 0 },
};

const STARTER_STATE: BillingState = {
  ...PRO_STATE,
  plan: "starter",
  entitlements: {
    ...PRO_STATE.entitlements,
    seats: 2,
    monthlyCreditAllowance: 500_000_000,
  },
};

const LEDGER_PAGE: Page<LedgerEntry> = {
  items: [
    {
      id: "led_1",
      workspaceId: "ws_first",
      kind: "grant",
      amount: 2_000_000_000,
      balanceAfter: 2_000_000_000,
      runId: null,
      idempotencyKey: "grant-key",
      metadata: {},
      createdAt: "2026-10-01T00:00:00Z",
    },
    {
      id: "led_2",
      workspaceId: "ws_first",
      kind: "commit",
      amount: -18_750_000,
      balanceAfter: 1_981_250_000,
      runId: "run_1",
      idempotencyKey: "commit-key",
      metadata: {},
      createdAt: "2026-10-21T09:00:00Z",
    },
  ],
  nextCursor: "cur_older",
};

const INVOICES: readonly BillingInvoiceRow[] = [
  {
    id: "inv_1",
    date: "2026-10-01T00:00:00Z",
    amountCents: 3900,
    currency: "usd",
    status: "paid",
    hostedUrl: "https://billing.stripe.test/invoice/1",
    pdfUrl: "https://billing.stripe.test/pdf/1",
  },
  {
    id: "inv_2",
    date: "2026-09-01T00:00:00Z",
    amountCents: 3900,
    currency: "usd",
    status: "open",
    hostedUrl: null,
    pdfUrl: null,
  },
];

/** One `GET /v1/renders` row for the usage-section fixtures (§7.2 wire v2). */
function usageRenderJob(overrides: Partial<RenderJob> = {}): RenderJob {
  return {
    id: "rend_1",
    projectId: "proj_alpha",
    compId: "comp_main",
    versionId: "ver_1",
    format: "mp4",
    settings: {},
    status: "completed",
    cancelRequested: false,
    progress: { framesDone: 240, framesTotal: 240, percent: 100 },
    credits: 14,
    resultUrl: "https://cdn.test/render.mp4",
    errorCode: null,
    error: null,
    sizeBytes: 13_000_000,
    createdBy: "user_1",
    createdAt: "2026-10-20T10:00:00Z",
    startedAt: "2026-10-20T10:00:05Z",
    completedAt: "2026-10-20T10:02:00Z",
    expiresAt: "2026-11-20T10:00:00Z",
    ...overrides,
  };
}

/** The faked billing port (the real ApiClient surface shape + the ledger). */
function fakePort(
  overrides: {
    checkout?: Mock;
    topup?: Mock;
    portal?: Mock;
    state?: Mock;
    ledger?: Mock;
    renders?: Mock;
  } = {},
) {
  return {
    checkout: overrides.checkout ?? vi.fn(),
    topup: overrides.topup ?? vi.fn(),
    portal: overrides.portal ?? vi.fn(),
    state: overrides.state ?? vi.fn(),
    ledger: overrides.ledger ?? vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    renders: overrides.renders ?? vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
  };
}

function apiError(code: string, message: string, hint?: string): ApiError {
  return new ApiError({
    code,
    message,
    status: 400,
    ...(hint === undefined ? {} : { hint }),
    requestId: "req_deadbeef",
  });
}

type ViewOverrides = Partial<Omit<BillingPageViewProps, "initialState" | "api">>;

function view(
  state: BillingState,
  port: ReturnType<typeof fakePort>,
  overrides: ViewOverrides = {},
): ReturnType<typeof render> {
  return render(
    <BillingPageView
      workspaceId="ws_first"
      workspaceName="First Films"
      initialState={state}
      invoices={[]}
      nowIso={NOW_ISO}
      api={port}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  assignMock.mockClear();
});

// ---------------------------------------------------------------------------
// Plan card (§8.8)
// ---------------------------------------------------------------------------

describe("BillingPageView — plan card", () => {
  it("renders the active plan: display name, price, status, renewal date and seats", () => {
    view(PRO_STATE, fakePort());
    expect(screen.getByTestId("billing-plan-name")).toHaveTextContent("Pro");
    expect(screen.getByTestId("billing-plan-price")).toHaveTextContent("$39/mo");
    expect(screen.getByTestId("billing-plan-status")).toHaveTextContent("Active");
    expect(screen.getByTestId("billing-plan-status-line")).toHaveTextContent("Renews Nov 1, 2026.");
    expect(screen.getByTestId("billing-seats")).toHaveTextContent("Up to 5 seats");
    expect(screen.getByText("200 GB")).toBeInTheDocument();
    expect(screen.getByText("600 / month")).toBeInTheDocument();
  });

  it("renders the trial state with days remaining (D-4: trial is a state)", () => {
    view(TRIAL_STATE, fakePort());
    expect(screen.getByTestId("billing-plan-name")).toHaveTextContent("Trial");
    expect(screen.getByTestId("billing-plan-price")).toHaveTextContent("Included during the trial");
    expect(screen.getByTestId("billing-plan-status")).toHaveTextContent("Trial");
    expect(screen.getByTestId("billing-plan-status-line")).toHaveTextContent(
      "Ends Nov 3, 2026 — 13 days left.",
    );
  });

  it("renders the dunning states: grace days and the declined card", () => {
    const grace: BillingState = {
      ...STARTER_STATE,
      status: "grace",
      graceEnd: "2026-10-30T00:00:00Z",
    };
    const graceView = view(grace, fakePort());
    expect(screen.getByTestId("billing-plan-status")).toHaveTextContent("Grace period");
    expect(screen.getByTestId("billing-plan-status-line")).toHaveTextContent(
      "Grace period ends Oct 30, 2026 — 8 days left to update payment.",
    );
    expect(screen.getByTestId("billing-payment-state")).toHaveTextContent(
      "The card on file was declined.",
    );
    graceView.unmount();

    const pastDue: BillingState = { ...STARTER_STATE, status: "past_due" };
    view(pastDue, fakePort());
    expect(screen.getByTestId("billing-plan-status")).toHaveTextContent("Past due");
  });

  it("falls back safely on an unknown status (wire drift never breaks the page)", () => {
    const drifted = { ...PRO_STATE, status: "paused" } as unknown as BillingState;
    view(drifted, fakePort());
    expect(screen.getByTestId("billing-plan-status")).toHaveTextContent("Status unavailable");
    expect(screen.getByTestId("billing-plan-status-line")).toHaveTextContent(
      "Refresh to see the latest billing status.",
    );
  });

  it("shows used vs allowed seats when a member count is provided", () => {
    view(PRO_STATE, fakePort(), { seatsUsed: 3 });
    expect(screen.getByTestId("billing-seats")).toHaveTextContent("3 of 5 seats used");
  });
});

// ---------------------------------------------------------------------------
// Credits + low-credit banner (§8.8; D-12 µc → credits at the UI boundary)
// ---------------------------------------------------------------------------

describe("BillingPageView — credits", () => {
  it("converts raw microcredits to credits (kit display math)", () => {
    view(PRO_STATE, fakePort());
    expect(screen.getByTestId("billing-credit-balance")).toHaveTextContent("12.35 credits");
    expect(screen.getByTestId("billing-credit-reserved")).toHaveTextContent("0.25 credits");
    expect(screen.getByTestId("billing-credit-allowance")).toHaveTextContent("2,000.00 credits");
  });

  it("raises the low-credit banner from the raw µc numbers (never an auto-charge)", () => {
    const low: BillingState = {
      ...PRO_STATE,
      credits: { balance: 400_000_000, reserved: 0 }, // 400 of 2,000 → ≤ 20%
    };
    const lowView = view(low, fakePort());
    const banner = screen.getByTestId("low-credit-banner");
    expect(banner).toHaveAttribute("data-level", "warning");
    expect(banner).toHaveTextContent("400.00 credits left");
    lowView.unmount();

    const urgent: BillingState = {
      ...PRO_STATE,
      credits: { balance: 0, reserved: 0 },
    };
    view(urgent, fakePort());
    const urgentBanner = screen.getByTestId("low-credit-banner");
    expect(urgentBanner).toHaveAttribute("data-level", "urgent");
    expect(urgentBanner).toHaveTextContent("New runs are blocked once credits reach zero.");
  });

  it("shows no banner while credits are healthy", () => {
    const healthy: BillingState = {
      ...PRO_STATE,
      credits: { balance: 1_500_000_000, reserved: 250_000 }, // 1,500 of 2,000
    };
    view(healthy, fakePort());
    expect(screen.queryByTestId("low-credit-banner")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Change plan — UpgradeCta composition (D-4: exactly starter/pro/studio)
// ---------------------------------------------------------------------------

describe("BillingPageView — change plan (UpgradeCta wiring)", () => {
  it("renders the D-4 strip: three paid tiers, catalog prices, current-plan badge, no trial row", () => {
    view(PRO_STATE, fakePort());
    expect(screen.getByTestId("upgrade-plan-starter")).toBeInTheDocument();
    expect(screen.getByTestId("upgrade-plan-pro")).toBeInTheDocument();
    expect(screen.getByTestId("upgrade-plan-studio")).toBeInTheDocument();
    expect(screen.queryByTestId("upgrade-plan-trial")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("upgrade-plan-starter")).getByText("$12")).toBeInTheDocument();
    expect(within(screen.getByTestId("upgrade-plan-pro")).getByText("$39")).toBeInTheDocument();
    expect(within(screen.getByTestId("upgrade-plan-studio")).getByText("$99")).toBeInTheDocument();
    expect(screen.getByTestId("upgrade-current-pro")).toHaveTextContent("Current plan");
    expect(screen.getByTestId("upgrade-choose-studio")).toHaveTextContent("Switch to Studio");
  });

  it("wires startCheckout to the port and redirects to the hosted session url", async () => {
    const user = userEvent.setup();
    const port = fakePort({
      checkout: vi
        .fn()
        .mockResolvedValue({ sessionId: "cs_1", url: "https://checkout.stripe.test/session" }),
    });
    view(PRO_STATE, port);
    await user.click(screen.getByTestId("upgrade-choose-studio"));
    await vi.waitFor(() =>
      expect(port.checkout).toHaveBeenCalledWith(
        { planId: "studio" },
        { idempotencyKey: expect.any(String) },
      ),
    );
    await vi.waitFor(() =>
      expect(assignMock).toHaveBeenCalledWith("https://checkout.stripe.test/session"),
    );
  });

  it("refreshes billing state in place on the planChanged arm (no redirect)", async () => {
    const user = userEvent.setup();
    const port = fakePort({
      checkout: vi
        .fn()
        .mockResolvedValue({ planChanged: true, sessionId: "", url: "" } as CheckoutResponse),
      state: vi.fn().mockResolvedValue(STARTER_STATE),
    });
    view(PRO_STATE, port);
    await user.click(screen.getByTestId("upgrade-choose-studio"));
    await vi.waitFor(() =>
      expect(screen.getByTestId("billing-plan-name")).toHaveTextContent("Starter"),
    );
    expect(port.state).toHaveBeenCalledTimes(1);
    expect(assignMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("upgrade-done")).toBeInTheDocument();
  });

  it("surfaces a typed checkout failure without a redirect", async () => {
    const user = userEvent.setup();
    const port = fakePort({
      checkout: vi
        .fn()
        .mockRejectedValue(
          apiError(
            "VALIDATION_FAILED",
            "Downgrades take effect at the end of the current billing period.",
            "Use the billing portal to schedule a downgrade.",
          ),
        ),
    });
    view(PRO_STATE, port);
    await user.click(screen.getByTestId("upgrade-choose-studio"));
    const banner = await screen.findByTestId("upgrade-error");
    expect(banner).toHaveTextContent(
      "Downgrades take effect at the end of the current billing period.",
    );
    expect(assignMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Top-up — TopUpFlow composition (packs from the billing state)
// ---------------------------------------------------------------------------

describe("BillingPageView — top-up (TopUpFlow wiring)", () => {
  it("serves the state's packs and posts the confirmed pack with an idempotency key", async () => {
    const user = userEvent.setup();
    const port = fakePort({
      topup: vi
        .fn()
        .mockResolvedValue({ sessionId: "cs_top", url: "https://checkout.stripe.test/topup" }),
    });
    view(PRO_STATE, port);
    // The pack grid carries the wire packs (prices live in Stripe, never here).
    expect(screen.getByTestId("topup-pack-credits500")).toHaveTextContent("500");
    expect(screen.getByTestId("topup-pack-credits500")).toHaveTextContent(
      "Price shown at checkout",
    );
    await user.click(screen.getByTestId("topup-pack-credits500"));
    await user.click(screen.getByTestId("topup-continue"));
    await user.click(screen.getByTestId("topup-confirm"));
    await vi.waitFor(() =>
      expect(port.topup).toHaveBeenCalledWith(
        { packId: "credits500" },
        { idempotencyKey: expect.any(String) },
      ),
    );
    await vi.waitFor(() =>
      expect(assignMock).toHaveBeenCalledWith("https://checkout.stripe.test/topup"),
    );
  });
});

// ---------------------------------------------------------------------------
// Ledger — LedgerTable composition (cursor pagination through the port)
// ---------------------------------------------------------------------------

describe("BillingPageView — credit ledger (LedgerTable wiring)", () => {
  it("fetches the first page on mount and renders the wire rows", async () => {
    const port = fakePort({ ledger: vi.fn().mockResolvedValue(LEDGER_PAGE) });
    view(PRO_STATE, port);
    await vi.waitFor(() => expect(port.ledger).toHaveBeenCalledWith({ limit: 50 }));
    expect(await screen.findAllByTestId("ledger-row")).toHaveLength(2);
    expect(screen.getByTestId("ledger-load-more")).toBeInTheDocument();
  });

  it("paginates forward through the cursor when Load more is clicked", async () => {
    const user = userEvent.setup();
    const ledgerMock = vi
      .fn()
      .mockResolvedValueOnce(LEDGER_PAGE)
      .mockResolvedValueOnce({ items: [], nextCursor: null });
    const port = fakePort({ ledger: ledgerMock });
    view(PRO_STATE, port);
    await screen.findByTestId("ledger-load-more");
    await user.click(screen.getByTestId("ledger-load-more"));
    await vi.waitFor(() =>
      expect(ledgerMock).toHaveBeenLastCalledWith({ cursor: "cur_older", limit: 50 }),
    );
    await vi.waitFor(() => expect(screen.getByTestId("ledger-end")).toBeInTheDocument());
  });
});

// ---------------------------------------------------------------------------
// Payment + portal (§8.8: card presence, manage payment)
// ---------------------------------------------------------------------------

describe("BillingPageView — payment", () => {
  it("derives card presence and opens a portal session with a return url", async () => {
    const user = userEvent.setup();
    const port = fakePort({
      portal: vi.fn().mockResolvedValue({ url: "https://billing.stripe.test/session" }),
    });
    view(PRO_STATE, port);
    expect(screen.getByTestId("billing-payment-state")).toHaveTextContent(
      "A payment method is on file.",
    );
    await user.click(screen.getByTestId("billing-manage-payment"));
    await vi.waitFor(() =>
      expect(port.portal).toHaveBeenCalledWith({
        returnUrl: "http://localhost:3000/w/billing",
      }),
    );
    await vi.waitFor(() =>
      expect(assignMock).toHaveBeenCalledWith("https://billing.stripe.test/session"),
    );
  });

  it("states when no payment method is on file (status none)", () => {
    const none: BillingState = { ...PRO_STATE, status: "none" };
    view(none, fakePort());
    expect(screen.getByTestId("billing-payment-state")).toHaveTextContent(
      "No payment method on file yet.",
    );
  });
});

// ---------------------------------------------------------------------------
// Cancel (§8.8: clear consequences; portal-mediated, no dark patterns)
// ---------------------------------------------------------------------------

describe("BillingPageView — cancel", () => {
  it("opens the confirm dialog, states the consequences and continues in the portal", async () => {
    const user = userEvent.setup();
    const port = fakePort({
      portal: vi.fn().mockResolvedValue({ url: "https://billing.stripe.test/cancel" }),
    });
    view(PRO_STATE, port);
    await user.click(screen.getByTestId("billing-cancel-button"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Cancel your subscription?")).toBeInTheDocument();
    expect(within(dialog).getByText(/never deleted/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Nov 1, 2026/)).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", { name: "Continue in the billing portal" }),
    );
    await vi.waitFor(() =>
      expect(port.portal).toHaveBeenCalledWith({
        returnUrl: "http://localhost:3000/w/billing",
      }),
    );
    await vi.waitFor(() =>
      expect(assignMock).toHaveBeenCalledWith("https://billing.stripe.test/cancel"),
    );
  });

  it("shows the renewal-cancelled card instead when cancellation is scheduled", () => {
    const ending: BillingState = { ...PRO_STATE, cancelAtPeriodEnd: true };
    view(ending, fakePort());
    expect(screen.getByText("Renewal cancelled")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Manage renewal in the billing portal" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("billing-cancel-button")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Invoices (rows today; the list endpoint is the worklog gap)
// ---------------------------------------------------------------------------

describe("BillingPageView — invoices", () => {
  it("renders rows with date, amount, status and links", () => {
    view(PRO_STATE, fakePort(), { invoices: INVOICES });
    const rows = screen.getAllByTestId("billing-invoice-row");
    expect(rows).toHaveLength(2);
    const firstRow = rows.at(0);
    const secondRow = rows.at(1);
    if (firstRow === undefined || secondRow === undefined) {
      throw new Error("expected both invoice rows to render");
    }
    expect(within(firstRow).getByText("Oct 1, 2026")).toBeInTheDocument();
    expect(within(firstRow).getByText("$39.00")).toBeInTheDocument();
    expect(within(firstRow).getByTestId("billing-invoice-status")).toHaveTextContent("paid");
    expect(within(firstRow).getByTestId("billing-invoice-view")).toHaveAttribute(
      "href",
      "https://billing.stripe.test/invoice/1",
    );
    expect(within(firstRow).getByTestId("billing-invoice-pdf")).toHaveAttribute(
      "href",
      "https://billing.stripe.test/pdf/1",
    );
    expect(within(secondRow).getByTestId("billing-invoice-status")).toHaveTextContent("open");
  });

  it("renders the honest empty state when there are no invoices yet", () => {
    view(PRO_STATE, fakePort(), { invoices: [] });
    expect(screen.getByTestId("billing-invoices-empty")).toHaveTextContent(
      "Invoices appear here after your first payment.",
    );
  });
});

// ---------------------------------------------------------------------------
// Usage section (W2-08/W3-H — UsageMeters finally mounted)
// ---------------------------------------------------------------------------

describe("BillingPageView — usage section", () => {
  it("mounts the Usage card between Credits and Payment", () => {
    const { container } = view(PRO_STATE, fakePort());
    const credits = container.querySelector('[data-testid="billing-credits"]');
    const usage = container.querySelector('[data-testid="billing-usage"]');
    const payment = container.querySelector('[data-testid="billing-payment"]');
    expect(usage).not.toBeNull();
    expect(credits).not.toBeNull();
    expect(payment).not.toBeNull();
    expect(credits?.compareDocumentPosition(usage as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(usage?.compareDocumentPosition(payment as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("drives the credits meter from the shared ledger page and labels the window honestly", async () => {
    const port = fakePort({ ledger: vi.fn().mockResolvedValue(LEDGER_PAGE) });
    view(PRO_STATE, port);
    const credits = await screen.findByTestId("usage-meter-credits");
    // LEDGER_PAGE carries one commit of -18,750,000 µc → 18.75 credits net.
    expect(credits).toHaveTextContent("18.75 of 2,000.00 credits");
    expect(credits).toHaveAttribute("data-state", "healthy");
    expect(screen.getByTestId("usage-ledger-committed")).toHaveTextContent("18.75 credits");
    // No period start on the wire → the honest fallback label, never "this cycle".
    expect(screen.getByTestId("usage-ledger-title")).toHaveTextContent("Latest ledger entries");
  });

  it("fetches renders through the port and renders the per-project table", async () => {
    const renders = vi.fn().mockResolvedValue({
      items: [usageRenderJob(), usageRenderJob({ id: "rend_2", projectId: "proj_beta" })],
      nextCursor: null,
    });
    view(PRO_STATE, fakePort({ renders }));
    await vi.waitFor(() => expect(renders).toHaveBeenCalledWith({ limit: 50 }));
    const table = await screen.findByTestId("usage-renders-table");
    expect(within(table).getAllByTestId("usage-renders-group")).toHaveLength(2);
    expect(within(table).getAllByTestId("usage-render-row")).toHaveLength(2);
  });

  it("keeps the usage card for read-only members but drops the top-up CTA", () => {
    view(PRO_STATE, fakePort(), { canManage: false });
    expect(screen.getByTestId("billing-usage")).toBeInTheDocument();
    expect(screen.queryByTestId("usage-topup")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Read-only members + the style law
// ---------------------------------------------------------------------------

describe("BillingPageView — read-only members and style law", () => {
  it("hides every management action for members without manageBilling", () => {
    view(PRO_STATE, fakePort(), { canManage: false });
    expect(screen.queryByTestId("topup-flow")).not.toBeInTheDocument();
    expect(screen.queryByTestId("upgrade-cta")).not.toBeInTheDocument();
    expect(screen.queryByTestId("billing-manage-payment")).not.toBeInTheDocument();
    expect(screen.queryByTestId("billing-cancel")).not.toBeInTheDocument();
    expect(screen.getByTestId("billing-read-only")).toHaveTextContent(
      "Only workspace admins can manage billing.",
    );
    expect(screen.getByTestId("billing-credit-balance")).toBeInTheDocument();
  });

  it("uses tokens only — no raw hex in any class attribute (law #8)", () => {
    const { container } = view(PRO_STATE, fakePort(), { invoices: INVOICES });
    const hexClass = /#[0-9a-f]{3,8}/i;
    const offenders = Array.from(container.querySelectorAll<HTMLElement>("[class]")).filter(
      (node) => hexClass.test(node.getAttribute("class") ?? ""),
    );
    expect(offenders).toHaveLength(0);
  });

  it("never renders the banned domain word in copy (law #9)", () => {
    const { container } = view(PRO_STATE, fakePort());
    expect(container.textContent).not.toContain("Document");
  });
});
