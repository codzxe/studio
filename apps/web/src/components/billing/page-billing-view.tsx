"use client";

/**
 * BillingPageView — the /w/billing client root (BUILD_PLAN §M6 task 4;
 * UI_DESIGN_SYSTEM §8.8 "Billing" + §14 microcopy).
 *
 * The RSC route (`app/(app)/w/billing/page.tsx`) resolves the workspace and
 * fetches the ONE billing read (`GET /v1/billing/state`) through the gateway
 * seam, then hands this component a serializable initial state. Everything
 * interactive lives here, COMPOSING the billing kit (M6-G, "binding for
 * M6-F"):
 *
 * - Plan card — catalog display name/price (`page-plan-display.ts`: the
 *   local D-4 pin — see the gap note there), subscription status incl.
 *   trialing/grace with days remaining, seats, models, storage and
 *   render-minute entitlements (always from the billing STATE — never pinned).
 * - LowCreditBanner — warning/urgent banner from the RAW µc numbers (D-12).
 * - Credits card — balance and reserves in RAW microcredits, converted to
 *   credits at this boundary (D-12), plus the monthly allowance.
 * - TopUpFlow — pack picker → confirm → `POST /v1/billing/topup` → redirect
 *   to the hosted session (prices live in Stripe, never on the wire).
 * - UpgradeCta — the D-4 pricing strip (exactly starter/pro/studio);
 *   checkout through `POST /v1/billing/checkout`: an immediate server-side
 *   switch answers `planChanged: true` (the page refreshes state in place),
 *   a first subscription answers a hosted Checkout `url` (redirect).
 * - LedgerTable — the append-only credit log via `GET /v1/credits/ledger`,
 *   cursor-paginated through the kit's `useLedgerPages` hook.
 * - Payment — card-on-file presence derived from the subscription state
 *   (the trial requires a card, BP §M6 task 5); "Manage payment" opens a
 *   `POST /v1/billing/portal` session and redirects.
 * - Invoices — rows today; the client-facing invoice list endpoint does not
 *   exist yet (M6-C's state carries none — see the worklog gap note), so the
 *   page renders what it is given and an honest empty state.
 * - Cancel — clear consequences, no dark patterns (§8.8): cancellation is
 *   status-only and completes in the Stripe billing portal (M6-C's shipped
 *   surface — there is no /v1/billing/cancel); the confirm dialog says what
 *   stays (everything — work is never deleted, BP §M6 task 2).
 *
 * Boundary law (apps/web): `@studio/contracts` is `import type` ONLY.
 * Action failures land in ONE typed banner (`billing-error`) with the §7.3
 * message + hint + request id (§14); the composed flows surface their own
 * bounded error states.
 */

import { type ApiClient, type CallOptions, createApiClient, isApiError } from "@studio/api-client";
import type {
  BillingState,
  CheckoutRequest,
  CheckoutResponse,
  PortalRequest,
  PortalResponse,
  TopUpRequest,
  TopUpResponse,
} from "@studio/contracts";
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  ConfirmDialog,
} from "@studio/ui";
import { useMemo, useState } from "react";

import { type LedgerPageFetcher, LedgerTable, useLedgerPages } from "./ledger-table";
import { LowCreditBanner } from "./low-credit-banner";
import {
  daysUntil,
  formatCount,
  formatCredits,
  formatDate,
  formatMonthlyPrice,
  formatStorage,
} from "./page-format";
import { BILLING_PLAN_DISPLAY, CURRENT_PLAN_DISPLAY } from "./page-plan-display";
import { TopUpFlow } from "./topup-flow";
import { UpgradeCta } from "./upgrade-cta";

// ---------------------------------------------------------------------------
// The api seam — a narrow port the real ApiClient satisfies structurally
// ---------------------------------------------------------------------------

/**
 * The billing surface `@studio/api-client` exposes. Production builds it from
 * `createApiClient` (same-origin `/v1` + `x-workspace-id`); tests fake it.
 */
export interface BillingPort {
  /** POST /v1/billing/checkout — subscribe/switch to a paid plan (D-4). */
  readonly checkout: (body: CheckoutRequest, options?: CallOptions) => Promise<CheckoutResponse>;
  /** POST /v1/billing/topup — one-time-payment credit pack. */
  readonly topup: (body: TopUpRequest, options?: CallOptions) => Promise<TopUpResponse>;
  /** POST /v1/billing/portal — Stripe customer portal session. */
  readonly portal: (body?: PortalRequest, options?: CallOptions) => Promise<PortalResponse>;
  /** GET /v1/billing/state — the ONE billing read (refreshes after switches). */
  readonly state: (options?: CallOptions) => Promise<BillingState>;
  /** GET /v1/credits/ledger — the append-only credit log (cursor pages). */
  readonly ledger: LedgerPageFetcher;
}

/**
 * Compile-time pin (and tiny adapter): the production `ApiClient["billing"]`
 * plus `credits.ledger` satisfies {@link BillingPort} — the page never
 * hand-rolls a call.
 */
export function asBillingPort(client: ApiClient): BillingPort {
  return {
    checkout: client.billing.checkout,
    topup: client.billing.topup,
    portal: client.billing.portal,
    state: client.billing.state,
    ledger: (query) => client.credits.ledger(query),
  };
}

/** Same-origin API root (Caddy fronts `/v1` in production — README §Env). */
const API_BASE_URL = "/v1";

/** Builds the production port for one workspace page load. */
function createDefaultBillingPort(workspaceId: string): BillingPort {
  return asBillingPort(
    createApiClient({ baseUrl: API_BASE_URL, headers: { "x-workspace-id": workspaceId } }),
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/**
 * One invoice row as the page renders it. MIRROR of M6-D's `invoices` table
 * columns (stripe_invoice_id, amount_cents, currency, status, hosted_url,
 * pdf_url) — the client-facing list endpoint is a noted gap; the RSC page
 * passes `[]` until it lands.
 */
export interface BillingInvoiceRow {
  readonly id: string;
  readonly date: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly status: "draft" | "open" | "paid" | "void" | "uncollectible";
  readonly hostedUrl: string | null;
  readonly pdfUrl: string | null;
}

export interface BillingPageViewProps {
  readonly workspaceId: string;
  readonly workspaceName: string;
  /** The server-fetched `GET /v1/billing/state` payload (the ONE read). */
  readonly initialState: BillingState;
  /** Invoice rows (empty until the list endpoint exists — the worklog gap). */
  readonly invoices: readonly BillingInvoiceRow[];
  /**
   * Seats in use, when a member-count read exists (gap: the state endpoint
   * carries the seat LIMIT only). Absent → the card shows the limit alone.
   */
  readonly seatsUsed?: number;
  /** ISO instant stamped by the RSC — day counts render identically everywhere. */
  readonly nowIso: string;
  /** Owners/admins (`manageBilling`) see management actions; others read. */
  readonly canManage?: boolean;
  /** Injectable port (tests). Production leaves it undefined. */
  readonly api?: BillingPort;
}

// ---------------------------------------------------------------------------
// Typed action errors (§7.3 surface: message + hint + request id)
// ---------------------------------------------------------------------------

interface BillingActionError {
  readonly message: string;
  readonly hint?: string;
  readonly requestId?: string;
}

function toActionError(error: unknown): BillingActionError {
  if (isApiError(error)) {
    return { message: error.message, hint: error.hint, requestId: error.requestId };
  }
  return { message: "Something went wrong on our side.", hint: "Try again in a moment." };
}

// ---------------------------------------------------------------------------
// Status presentation (§8.8 plan card; days remaining for trialing/grace)
// ---------------------------------------------------------------------------

const LIVE_STATUSES = new Set(["trialing", "active", "past_due", "grace"]);

type BadgeVariant = "neutral" | "success" | "warning" | "danger" | "ice";

interface StatusView {
  readonly badge: BadgeVariant;
  readonly label: string;
  readonly line: string;
}

function dayWord(count: number): string {
  return `${formatCount(count)} ${count === 1 ? "day" : "days"} left`;
}

function statusView(state: BillingState, now: Date): StatusView {
  switch (state.status) {
    case "trialing":
      return {
        badge: "ice",
        label: "Trial",
        line:
          state.trialEnd === null
            ? "Your trial is running."
            : `Ends ${formatDate(state.trialEnd)} — ${dayWord(daysUntil(state.trialEnd, now))}.`,
      };
    case "active":
      return state.cancelAtPeriodEnd
        ? {
            badge: "warning",
            label: "Active",
            line: `Renewal is cancelled — your plan ends ${formatDate(state.currentPeriodEnd)}.`,
          }
        : {
            badge: "success",
            label: "Active",
            line: `Renews ${formatDate(state.currentPeriodEnd)}.`,
          };
    case "past_due":
      return {
        badge: "danger",
        label: "Past due",
        line: "The card on file was declined — update your payment to keep creating.",
      };
    case "grace":
      return {
        badge: "warning",
        label: "Grace period",
        line:
          state.graceEnd === null
            ? "Update your payment to keep creating."
            : `Grace period ends ${formatDate(state.graceEnd)} — ${dayWord(daysUntil(state.graceEnd, now))} to update payment.`,
      };
    case "canceled":
      return {
        badge: "danger",
        label: "Cancelled",
        line: "Choose a plan below to subscribe again. Your work is never deleted.",
      };
    case "incomplete":
      return {
        badge: "warning",
        label: "Payment incomplete",
        line: "Finish payment to activate your subscription.",
      };
    case "none":
      return {
        badge: "neutral",
        label: "No subscription",
        line: "Choose a plan below to start creating.",
      };
    default:
      // Wire drift: an unknown status never breaks the page.
      return {
        badge: "neutral",
        label: "Status unavailable",
        line: "Refresh to see the latest billing status.",
      };
  }
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export function BillingPageView({
  workspaceId,
  workspaceName,
  initialState,
  invoices,
  seatsUsed,
  nowIso,
  canManage = true,
  api,
}: BillingPageViewProps) {
  const port = useMemo(() => api ?? createDefaultBillingPort(workspaceId), [api, workspaceId]);
  const [state, setState] = useState<BillingState>(initialState);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<BillingActionError | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const now = useMemo(() => new Date(nowIso), [nowIso]);

  const isLive = LIVE_STATUSES.has(state.status);
  const current = CURRENT_PLAN_DISPLAY[state.plan] ?? { name: state.plan, priceCents: null };
  const priceLine =
    current.priceCents === null
      ? "Included during the trial"
      : formatMonthlyPrice(current.priceCents);

  const ledger = useLedgerPages(port.ledger);

  async function refresh(): Promise<void> {
    if (busy !== null) return;
    setBusy("refresh");
    setActionError(null);
    try {
      setState(await port.state());
    } catch (error) {
      setActionError(toActionError(error));
    } finally {
      setBusy(null);
    }
  }

  /** Portal sessions: payment management, downgrades and cancellation. */
  async function openPortal(intent: string): Promise<void> {
    if (busy !== null) return;
    setBusy(`portal:${intent}`);
    setActionError(null);
    try {
      const session = await port.portal({
        returnUrl: `${window.location.origin}/w/billing`,
      });
      window.location.assign(session.url);
    } catch (error) {
      setActionError(toActionError(error));
    } finally {
      setBusy(null);
    }
  }

  const status = statusView(state, now);
  const seatsLine =
    seatsUsed === undefined
      ? `Up to ${formatCount(state.entitlements.seats)} seats`
      : `${formatCount(seatsUsed)} of ${formatCount(state.entitlements.seats)} seats used`;

  return (
    <main id="main" data-testid="billing-view" className="min-h-svh bg-app px-5 py-10">
      <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-title-l font-medium text-primary">Billing</h1>
            <p className="text-body-s text-muted">
              Plan, credits and invoices for {workspaceName}.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              loading={busy === "refresh"}
              disabled={busy !== null && busy !== "refresh"}
              onClick={() => {
                void refresh();
              }}
              data-testid="billing-refresh"
            >
              Refresh
            </Button>
            <a
              href="/w"
              className="text-body-s text-secondary underline underline-offset-3 hover:text-primary"
            >
              Back to workspace
            </a>
          </div>
        </header>

        {/* §8.8 low-credit banner (RAW µc; never an auto-charge). */}
        <LowCreditBanner
          balanceMicrocredits={state.credits.balance}
          allowanceMicrocredits={state.entitlements.monthlyCreditAllowance}
          onTopUp={
            canManage
              ? () => {
                  document
                    .querySelector<HTMLElement>('[data-testid="topup-flow"]')
                    ?.scrollIntoView();
                }
              : undefined
          }
        />

        {actionError !== null && (
          <div
            role="alert"
            data-testid="billing-error"
            className="flex flex-col gap-1 rounded-sm border border-danger/30 bg-danger/10 p-4 text-body-s"
          >
            <span className="font-medium text-primary">{actionError.message}</span>
            {actionError.hint !== undefined && (
              <span className="text-secondary">{actionError.hint}</span>
            )}
            {actionError.requestId !== undefined && (
              <span className="text-caption text-muted">Request id {actionError.requestId}</span>
            )}
          </div>
        )}

        {/* ── Plan ────────────────────────────────────────────────────── */}
        <Card data-testid="billing-plan">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-col gap-1.5">
                <CardTitle data-testid="billing-plan-name">{current.name}</CardTitle>
                <CardDescription>Current plan</CardDescription>
              </div>
              <div className="flex flex-col items-end gap-1.5">
                <Badge variant={status.badge} data-testid="billing-plan-status">
                  {status.label}
                </Badge>
                <span className="text-body-s text-muted" data-testid="billing-plan-price">
                  {priceLine}
                </span>
              </div>
            </div>
          </CardHeader>
          <p className="text-body-s text-secondary" data-testid="billing-plan-status-line">
            {status.line}
          </p>
          <dl
            className="mt-4 grid grid-cols-1 gap-x-8 gap-y-2 text-body-s sm:grid-cols-2"
            data-testid="billing-plan-entitlements"
          >
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-muted">Seats</dt>
              <dd className="text-secondary tabular-nums" data-testid="billing-seats">
                {seatsLine}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-muted">Models</dt>
              <dd className="text-secondary">{state.entitlements.models.join(", ")}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-muted">Projects</dt>
              <dd className="text-secondary tabular-nums">
                Up to {formatCount(state.entitlements.maxProjects)}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-muted">Storage</dt>
              <dd className="text-secondary tabular-nums">
                {formatStorage(state.entitlements.storageBytes)}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-muted">Render minutes</dt>
              <dd className="text-secondary tabular-nums">
                {formatCount(state.entitlements.renderMinutesPerMonth)} / month
              </dd>
            </div>
          </dl>
        </Card>

        {/* ── Credits ─────────────────────────────────────────────────── */}
        <Card data-testid="billing-credits">
          <CardHeader>
            <CardTitle>Credits</CardTitle>
            <CardDescription>
              Balance and allowance in credits; reserves are held by running jobs.
            </CardDescription>
          </CardHeader>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-2 text-body-s sm:grid-cols-3">
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-muted">Balance</dt>
              <dd
                className="font-medium text-primary tabular-nums"
                data-testid="billing-credit-balance"
              >
                {formatCredits(state.credits.balance)} credits
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-muted">Held by running jobs</dt>
              <dd className="text-secondary tabular-nums" data-testid="billing-credit-reserved">
                {formatCredits(state.credits.reserved)} credits
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-muted">Included each month</dt>
              <dd className="text-secondary tabular-nums" data-testid="billing-credit-allowance">
                {formatCredits(state.entitlements.monthlyCreditAllowance)} credits
              </dd>
            </div>
          </dl>
        </Card>

        {/* ── Top-up (M6-G kit: packs from the billing state) ──────────── */}
        {canManage && (
          <TopUpFlow
            packs={state.topUpPacks}
            startTopUp={(packId, options) =>
              port.topup({ packId }, { idempotencyKey: options.idempotencyKey })
            }
          />
        )}

        {/* ── Change plan (M6-G kit; D-4: exactly starter/pro/studio) ───── */}
        {canManage && (
          <UpgradeCta
            plans={BILLING_PLAN_DISPLAY}
            currentPlan={state.plan}
            startCheckout={(planId, options) =>
              port.checkout({ planId }, { idempotencyKey: options.idempotencyKey })
            }
            onPlanChanged={() => {
              void refresh();
            }}
            title="Change plan"
          />
        )}
        {!canManage && (
          <p className="text-body-s text-muted" data-testid="billing-read-only">
            Only workspace admins can manage billing.
          </p>
        )}

        {/* ── Payment ──────────────────────────────────────────────────── */}
        <Card data-testid="billing-payment">
          <CardHeader>
            <CardTitle>Payment</CardTitle>
            <CardDescription>
              Cards and receipts are managed in the secure billing portal.
            </CardDescription>
          </CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-body-s text-secondary" data-testid="billing-payment-state">
              {state.status === "none"
                ? "No payment method on file yet."
                : state.status === "past_due" || state.status === "grace"
                  ? "The card on file was declined."
                  : "A payment method is on file."}
            </p>
            {canManage && (
              <Button
                variant="secondary"
                size="sm"
                loading={busy === "portal:manage"}
                disabled={busy !== null && busy !== "portal:manage"}
                onClick={() => {
                  void openPortal("manage");
                }}
                data-testid="billing-manage-payment"
              >
                Manage payment
              </Button>
            )}
          </div>
        </Card>

        {/* ── Invoices ────────────────────────────────────────────────── */}
        <Card data-testid="billing-invoices">
          <CardHeader>
            <CardTitle>Invoices</CardTitle>
            <CardDescription>Every payment you make shows up here.</CardDescription>
          </CardHeader>
          <InvoiceTable invoices={invoices} />
        </Card>

        {/* ── Credit ledger (M6-G kit; the append-only log) ────────────── */}
        <Card data-testid="billing-ledger">
          <CardHeader>
            <CardTitle>Credit ledger</CardTitle>
            <CardDescription>
              Every credit grant, reserve, spend and refund — append-only.
            </CardDescription>
          </CardHeader>
          <LedgerTable
            entries={ledger.entries}
            nextCursor={ledger.nextCursor}
            loading={ledger.loading}
            error={ledger.error}
            onLoadMore={ledger.loadMore}
            onRetry={ledger.retry}
          />
        </Card>

        {/* ── Cancel ──────────────────────────────────────────────────── */}
        {canManage && isLive && !state.cancelAtPeriodEnd && (
          <Card data-testid="billing-cancel">
            <CardHeader>
              <CardTitle>Cancel subscription</CardTitle>
              <CardDescription>
                Cancellation keeps your plan until the period ends and never deletes work.
              </CardDescription>
            </CardHeader>
            <Button
              variant="danger"
              size="sm"
              loading={busy === "portal:cancel"}
              disabled={busy !== null && busy !== "portal:cancel"}
              onClick={() => {
                setCancelOpen(true);
              }}
              data-testid="billing-cancel-button"
            >
              Cancel subscription
            </Button>
            <ConfirmDialog
              open={cancelOpen}
              onOpenChange={setCancelOpen}
              title="Cancel your subscription?"
              description={
                <>
                  Your plan stays active until {formatDate(state.currentPeriodEnd)}. Your projects,
                  compositions and versions are never deleted. You will confirm the cancellation in
                  the secure billing portal.
                </>
              }
              confirmLabel="Continue in the billing portal"
              busy={busy === "portal:cancel"}
              onConfirm={() => {
                setCancelOpen(false);
                void openPortal("cancel");
              }}
            />
          </Card>
        )}
        {canManage && isLive && state.cancelAtPeriodEnd && (
          <Card data-testid="billing-cancel">
            <CardHeader>
              <CardTitle>Renewal cancelled</CardTitle>
              <CardDescription>
                Your plan ends {formatDate(state.currentPeriodEnd)} and will not renew.
              </CardDescription>
            </CardHeader>
            <Button
              variant="secondary"
              size="sm"
              loading={busy === "portal:resume"}
              disabled={busy !== null && busy !== "portal:resume"}
              onClick={() => {
                void openPortal("resume");
              }}
              data-testid="billing-cancel-manage"
            >
              Manage renewal in the billing portal
            </Button>
          </Card>
        )}
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Invoice table (rows today; the list endpoint is the worklog gap)
// ---------------------------------------------------------------------------

const INVOICE_BADGE: Readonly<Record<BillingInvoiceRow["status"], BadgeVariant>> = {
  draft: "neutral",
  open: "ice",
  paid: "success",
  void: "neutral",
  uncollectible: "danger",
};

function formatInvoiceAmount(amountCents: number, currency: string): string {
  if (!Number.isFinite(amountCents) || amountCents < 0 || currency === "") return "—";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
      amountCents / 100,
    );
  } catch {
    return "—";
  }
}

function InvoiceTable({ invoices }: { invoices: readonly BillingInvoiceRow[] }) {
  if (invoices.length === 0) {
    return (
      <p className="text-body-s text-muted" data-testid="billing-invoices-empty">
        Invoices appear here after your first payment.
      </p>
    );
  }
  return (
    <ul className="flex flex-col divide-y divide-border" data-testid="billing-invoice-list">
      {invoices.map((invoice) => (
        <li
          key={invoice.id}
          data-testid="billing-invoice-row"
          className="flex flex-wrap items-center justify-between gap-3 py-3"
        >
          <span className="text-body-s text-secondary tabular-nums">
            {formatDate(invoice.date)}
          </span>
          <span className="text-body-s font-medium text-primary tabular-nums">
            {formatInvoiceAmount(invoice.amountCents, invoice.currency)}
          </span>
          <Badge variant={INVOICE_BADGE[invoice.status]} data-testid="billing-invoice-status">
            {invoice.status}
          </Badge>
          <span className="flex items-center gap-3">
            {invoice.hostedUrl !== null && (
              <a
                href={invoice.hostedUrl}
                className="text-body-s text-secondary underline underline-offset-3 hover:text-primary"
                data-testid="billing-invoice-view"
              >
                View
              </a>
            )}
            {invoice.pdfUrl !== null && (
              <a
                href={invoice.pdfUrl}
                className="text-body-s text-secondary underline underline-offset-3 hover:text-primary"
                data-testid="billing-invoice-pdf"
              >
                PDF
              </a>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
