"use client";

/**
 * TopUpFlow — the §8.8 "Credits → top-up packs" purchase flow (BUILD_PLAN
 * §M6 task 4; wire contract packages/contracts/src/routes/billing.ts).
 *
 * Flow: pack picker → confirm → `POST /v1/billing/topup` → redirect to the
 * Stripe Checkout session `url`. Prices live in Stripe and are NEVER on the
 * wire, so each pack card carries a price PLACEHOLDER ("Price shown at
 * checkout") — no invented price, per §8.8 honesty rules.
 *
 * Idempotency & replay safety (law #4):
 *  - one idempotency key PER ATTEMPT, generated when the confirm gesture
 *    fires and passed to the seam via `options.idempotencyKey` (the page
 *    forwards it to `client.billing.topup(body, { idempotencyKey })`, where
 *    the gateway middleware replays the original result for a re-sent key);
 *  - every control is disabled while the POST is in flight, so a double
 *    click can never double-fire;
 *  - a retry after a FAILED attempt uses a FRESH key — a duplicate Checkout
 *    session is never a charge (only completing the hosted checkout is).
 *
 * Boundary law (apps/web): `@studio/contracts` is import-type only, so the
 * pack catalog is pinned in ONE shared module — ./top-up-packs (`satisfies
 * readonly BillingTopUpPack[]` against the wire types: a contracts change
 * breaks typecheck, and top-up-packs.test.ts pins the values) — instead of
 * a runtime import. The api-client validates the real wire at runtime.
 *
 * Exported surface (binding for M6-F):
 *   TopUpFlowProps + TopUpFlow + TopUpStart + TopUpAttemptOptions + RedirectTo
 *   (the wire pack catalog pin lives in ./top-up-packs)
 */

import type { BillingTopUpPack, TopUpPackId, TopUpResponse } from "@studio/contracts";
import { Badge, Button, cn } from "@studio/ui";
import { CircleAlert, ExternalLink } from "lucide-react";
import { useState } from "react";
import type { ReactElement } from "react";
import { truncateForDisplay } from "./ledger-table";
import { TOP_UP_PACKS } from "./top-up-packs";

// ---------------------------------------------------------------------------
// Seam types
// ---------------------------------------------------------------------------

/** Options the flow attaches to ONE purchase attempt (law #4). */
export interface TopUpAttemptOptions {
  /** Idempotency key for this attempt — the gateway replays on re-send. */
  readonly idempotencyKey: string;
}

/**
 * The `POST /v1/billing/topup` seam — the page wires it to the api-client:
 *   (packId, { idempotencyKey }) => client.billing.topup({ packId }, { idempotencyKey })
 */
export type TopUpStart = (
  packId: TopUpPackId,
  options: TopUpAttemptOptions,
) => Promise<TopUpResponse>;

/** Redirect seam, overridable in tests; defaults to `window.location.assign`. */
export type RedirectTo = (url: string) => void;

/** Default redirect: full-page navigation to the hosted Checkout session. */
export function defaultRedirectTo(url: string): void {
  if (typeof window !== "undefined" && typeof window.location?.assign === "function") {
    window.location.assign(url);
  }
}

/** Checkout targets must be http(s) URLs of a sane length (hostile wire). */
export function isSafeCheckoutUrl(url: string): boolean {
  if (url.length === 0 || url.length > 2048) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/** Wire-safe error text: bounded, never a raw dump of a hostile throw. */
function topUpErrorMessage(cause: unknown): string {
  if (cause instanceof Error && typeof cause.message === "string" && cause.message.length > 0) {
    return truncateForDisplay(cause.message);
  }
  return "The top-up could not be started.";
}

/** Whole-credit display for pack cards ("2,000"); hostile values degrade. */
function formatWholeCredits(credits: number): string {
  if (!Number.isFinite(credits)) return "—";
  return Math.round(Math.max(credits, 0)).toLocaleString("en-US");
}

// ---------------------------------------------------------------------------
// TopUpFlow
// ---------------------------------------------------------------------------

type TopUpStatus = "picker" | "confirm" | "busy" | "redirecting" | "error";

export interface TopUpFlowProps {
  /** Packs from `GET /v1/billing/state` → `topUpPacks`; defaults to the wire catalog. */
  readonly packs?: readonly BillingTopUpPack[];
  /** Required: the `POST /v1/billing/topup` seam (see `TopUpStart`). */
  readonly startTopUp: TopUpStart;
  readonly redirectTo?: RedirectTo;
  /** Injectable idempotency-key factory (8–128 chars, §7.2); default crypto UUID. */
  readonly idempotencyKeyFactory?: () => string;
  /** Page-level lock: disables every control (a billing action is in flight). */
  readonly busy?: boolean;
  readonly className?: string;
}

export function TopUpFlow({
  packs = TOP_UP_PACKS,
  startTopUp,
  redirectTo = defaultRedirectTo,
  idempotencyKeyFactory = () => crypto.randomUUID(),
  busy = false,
  className,
}: TopUpFlowProps): ReactElement {
  const [selectedPackId, setSelectedPackId] = useState<TopUpPackId | null>(null);
  const [status, setStatus] = useState<TopUpStatus>("picker");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);

  const locked = busy || status === "busy" || status === "redirecting";
  const selectedPack = packs.find((pack) => pack.packId === selectedPackId) ?? null;

  const choose = (packId: TopUpPackId): void => {
    if (locked) return;
    setSelectedPackId(packId);
    setStatus("picker");
    setErrorMessage(null);
  };

  const startAttempt = (): void => {
    if (selectedPackId === null || locked) return;
    const idempotencyKey = idempotencyKeyFactory();
    setStatus("busy");
    setErrorMessage(null);
    startTopUp(selectedPackId, { idempotencyKey })
      .then((response) => {
        const url = typeof response?.url === "string" ? response.url : "";
        if (!isSafeCheckoutUrl(url)) {
          setStatus("error");
          setErrorMessage("The checkout link from the server was invalid.");
          return;
        }
        setCheckoutUrl(url);
        setStatus("redirecting");
        redirectTo(url);
      })
      .catch((cause: unknown) => {
        setStatus("error");
        setErrorMessage(topUpErrorMessage(cause));
      });
  };

  return (
    <section
      aria-label="Buy credits"
      data-testid="topup-flow"
      data-status={status}
      className={className}
    >
      {status === "redirecting" && checkoutUrl !== null ? (
        <output
          data-testid="topup-redirecting"
          className="flex flex-wrap items-center gap-2 rounded-sm border border-border bg-panel px-3 py-2 text-caption text-primary"
        >
          <span className="min-w-0 flex-1">Opening secure checkout…</span>
          <a
            data-testid="topup-continue-link"
            href={checkoutUrl}
            className="inline-flex items-center gap-1.5 text-primary underline underline-offset-3 transition-colors duration-120 hover:text-signal"
          >
            <ExternalLink size={14} strokeWidth={1.75} aria-hidden="true" />
            Continue to checkout
          </a>
        </output>
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-3" data-testid="topup-pack-grid">
            {packs.map((pack) => {
              const selected = pack.packId === selectedPackId;
              return (
                <button
                  key={pack.packId}
                  type="button"
                  data-testid={`topup-pack-${pack.packId}`}
                  data-selected={selected || undefined}
                  aria-pressed={selected}
                  disabled={locked}
                  onClick={() => choose(pack.packId)}
                  className={cn(
                    "flex flex-col items-start gap-1 rounded-sm border px-3 py-2.5 text-left transition-colors duration-120 focus-visible:outline-2 focus-visible:outline-signal",
                    selected
                      ? "border-signal bg-elevated"
                      : "border-border bg-panel hover:border-border-strong hover:bg-elevated",
                    "disabled:pointer-events-none disabled:opacity-45",
                  )}
                >
                  <span className="tabular text-body font-medium text-primary">
                    {formatWholeCredits(pack.credits)}
                    <span className="ml-1 text-caption font-normal text-muted">credits</span>
                  </span>
                  <span className="text-caption text-muted">Price shown at checkout</span>
                  {selected ? (
                    <Badge variant="signal" className="mt-0.5">
                      Selected
                    </Badge>
                  ) : null}
                </button>
              );
            })}
          </div>

          {status === "picker" || status === "confirm" || status === "busy" ? (
            <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="topup-actions">
              {status === "picker" ? (
                <Button
                  size="sm"
                  data-testid="topup-continue"
                  disabled={selectedPack === null || locked}
                  onClick={() => setStatus("confirm")}
                >
                  Continue
                </Button>
              ) : (
                <>
                  <p
                    className="min-w-0 flex-1 text-caption text-secondary"
                    data-testid="topup-confirm-copy"
                  >
                    You’re buying {selectedPack ? formatWholeCredits(selectedPack.credits) : "—"}{" "}
                    credits. The charge happens on Stripe’s secure checkout page.
                  </p>
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid="topup-back"
                    disabled={locked}
                    onClick={() => setStatus("picker")}
                  >
                    Back
                  </Button>
                  <Button
                    size="sm"
                    data-testid="topup-confirm"
                    disabled={selectedPack === null || busy}
                    loading={status === "busy"}
                    onClick={startAttempt}
                  >
                    Confirm purchase
                  </Button>
                </>
              )}
            </div>
          ) : null}

          {status === "error" ? (
            <div
              role="alert"
              data-testid="topup-error"
              className="mt-3 flex flex-wrap items-center gap-2 rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-caption text-primary"
            >
              <CircleAlert
                size={16}
                strokeWidth={1.75}
                aria-hidden="true"
                className="shrink-0 text-danger"
              />
              <p className="min-w-0 flex-1">{errorMessage ?? "The top-up could not be started."}</p>
              <Button
                size="sm"
                variant="ghost"
                data-testid="topup-back"
                onClick={() => setStatus("picker")}
              >
                Back
              </Button>
              <Button
                size="sm"
                variant="secondary"
                data-testid="topup-retry"
                onClick={startAttempt}
              >
                Try again
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
