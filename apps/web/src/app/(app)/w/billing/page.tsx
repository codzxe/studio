import type { BillingState } from "@studio/contracts";
import { EmptyState } from "@studio/ui";
import { notFound, redirect } from "next/navigation";

import { type BillingInvoiceRow, BillingPageView } from "@/components/billing/page-billing-view";
import { gatewayCall, isGatewayHttpError } from "@/lib/gateway";
import { pageMetadata } from "@/lib/seo";

/**
 * The billing route (BUILD_PLAN §M6 task 4; UI_DESIGN_SYSTEM §8.8).
 *
 * `/w/billing` — ONE server-side read (`GET /v1/billing/state`, the single
 * billing read the UI consumes) through the RSC gateway seam, then the
 * client view (`components/billing/page-billing-view.tsx`) owns every
 * mutation: checkout, top-up, portal and cancel all go through
 * `@studio/api-client` same-origin with the workspace header.
 *
 * - Workspace resolution: `/v1/me → memberships`, honoring `?ws=<id or
 *   slug>` (the workspace-switcher seam — v1 defaults to the first
 *   membership); an explicit-but-unknown `?ws` is a 404 (hard rule 3).
 * - Expired session → `/sign-in` with a `next` round-trip (the proxy only
 *   checks cookie presence; the gateway checks validity).
 * - Cross-tenant or missing billing state → 404; malformed state → an
 *   honest empty state (never a stack, law #1).
 * - Management actions render for owners/admins only — the gateway's
 *   `manageBilling` capability; other members read the page.
 */

export const metadata = pageMetadata({
  title: "Billing",
  description: "Plan, credits and invoices for your workspace.",
  path: "/w/billing",
});

// ---------------------------------------------------------------------------
// Wire shapes consumed (§7.2, type-only restatements — see lib/gateway.ts)
// ---------------------------------------------------------------------------

interface MembershipWire {
  readonly workspaceId: string;
  readonly role: "owner" | "admin" | "editor" | "viewer";
  readonly workspace: { readonly id: string; readonly name: string; readonly slug: string };
}

/** Wire statuses of `GET /v1/billing/state` (contracts BILLING_STATUSES). */
const BILLING_PAGE_STATUSES = [
  "none",
  "trialing",
  "active",
  "past_due",
  "grace",
  "canceled",
  "incomplete",
] as const;

/** Wire plan ids (contracts PLAN_ID union — trial is a state, D-4). */
const BILLING_PAGE_PLANS = ["trial", "starter", "pro", "studio"] as const;

/** Wire top-up pack ids (contracts TOP_UP_PACK_IDS). */
const BILLING_PAGE_PACK_IDS = ["credits100", "credits500", "credits2000"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Finite non-negative number, or null (bad wire input never renders). */
function countOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseMemberships(value: unknown): MembershipWire[] {
  if (!isRecord(value) || !Array.isArray(value.memberships)) return [];
  const out: MembershipWire[] = [];
  for (const raw of value.memberships) {
    if (!isRecord(raw) || !isRecord(raw.workspace)) continue;
    if (typeof raw.workspaceId !== "string") continue;
    if (typeof raw.workspace.id !== "string") continue;
    if (typeof raw.workspace.name !== "string") continue;
    if (typeof raw.workspace.slug !== "string") continue;
    if (typeof raw.role !== "string") continue;
    const role =
      raw.role === "owner" || raw.role === "admin" || raw.role === "editor" || raw.role === "viewer"
        ? raw.role
        : "viewer";
    out.push({
      workspaceId: raw.workspaceId,
      role,
      workspace: { id: raw.workspace.id, name: raw.workspace.name, slug: raw.workspace.slug },
    });
  }
  return out;
}

/**
 * Hand-rolled shape guard for `GET /v1/billing/state` (apps/web never
 * runtime-imports the contracts barrel — the api-client zod-validates the
 * CLIENT-side refreshes; this restates the same wire server-side).
 * Malformed anywhere → null → the honest empty state.
 */
function parseBillingState(value: unknown): BillingState | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.plan !== "string" ||
    !(BILLING_PAGE_PLANS as readonly string[]).includes(value.plan)
  ) {
    return null;
  }
  if (
    typeof value.status !== "string" ||
    !(BILLING_PAGE_STATUSES as readonly string[]).includes(value.status)
  ) {
    return null;
  }
  if (typeof value.cancelAtPeriodEnd !== "boolean") return null;
  const credits = isRecord(value.credits) ? value.credits : null;
  if (
    credits === null ||
    typeof credits.balance !== "number" ||
    typeof credits.reserved !== "number"
  ) {
    return null;
  }
  const entitlements = isRecord(value.entitlements) ? value.entitlements : null;
  if (entitlements === null) return null;
  const seats = countOrNull(entitlements.seats);
  const maxProjects = countOrNull(entitlements.maxProjects);
  const storageBytes = countOrNull(entitlements.storageBytes);
  const renderMinutesPerMonth = countOrNull(entitlements.renderMinutesPerMonth);
  const monthlyCreditAllowance = countOrNull(entitlements.monthlyCreditAllowance);
  if (
    seats === null ||
    maxProjects === null ||
    storageBytes === null ||
    renderMinutesPerMonth === null ||
    monthlyCreditAllowance === null
  ) {
    return null;
  }
  if (
    !Array.isArray(entitlements.models) ||
    entitlements.models.some((m) => typeof m !== "string")
  ) {
    return null;
  }
  if (!Array.isArray(value.topUpPacks)) return null;
  const packs: { packId: (typeof BILLING_PAGE_PACK_IDS)[number]; credits: number }[] = [];
  for (const pack of value.topUpPacks) {
    if (!isRecord(pack) || typeof pack.packId !== "string") continue;
    if (!(BILLING_PAGE_PACK_IDS as readonly string[]).includes(pack.packId)) continue;
    const packCredits = countOrNull(pack.credits);
    if (packCredits === null || packCredits <= 0) continue;
    packs.push({
      packId: pack.packId as (typeof BILLING_PAGE_PACK_IDS)[number],
      credits: packCredits,
    });
  }
  return {
    plan: value.plan as BillingState["plan"],
    status: value.status as BillingState["status"],
    currentPeriodEnd: stringOrNull(value.currentPeriodEnd),
    trialEnd: stringOrNull(value.trialEnd),
    cancelAtPeriodEnd: value.cancelAtPeriodEnd,
    graceEnd: stringOrNull(value.graceEnd),
    entitlements: {
      seats,
      models: entitlements.models,
      maxProjects,
      storageBytes,
      renderMinutesPerMonth,
      monthlyCreditAllowance,
    },
    credits: { balance: credits.balance, reserved: credits.reserved },
    topUpPacks: packs,
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

interface BillingPageProps {
  readonly searchParams: Promise<{ readonly ws?: string }>;
}

type BillingResolution =
  | { readonly status: "empty" }
  | { readonly status: "unavailable" }
  | {
      readonly status: "ready";
      readonly payload: {
        readonly workspaceId: string;
        readonly workspaceName: string;
        readonly canManage: boolean;
        readonly state: BillingState;
        /** Recorded Stripe invoice rows (W1-e tail; tolerant load). */
        readonly invoices: readonly BillingInvoiceRow[];
      };
    };

async function loadBillingPage(ws: string | undefined): Promise<BillingResolution> {
  const me = await gatewayCall<unknown>("/v1/me");
  const memberships = parseMemberships(me);
  const [first] = memberships;
  if (first === undefined) {
    return { status: "empty" };
  }

  // ?ws=<id or slug> — the workspace-switcher seam; unknown → 404 (rule 3).
  const membership =
    ws === undefined
      ? first
      : (memberships.find(
          (m) => m.workspaceId === ws || m.workspace.slug === ws || m.workspace.id === ws,
        ) ?? null);
  if (membership === null) {
    notFound();
  }

  let state: unknown;
  try {
    state = await gatewayCall<unknown>("/v1/billing/state", {
      workspaceId: membership.workspaceId,
    });
  } catch (error) {
    if (isGatewayHttpError(error)) {
      if (error.status === 401 || error.code === "UNAUTHORIZED") {
        redirect(`/sign-in?next=${encodeURIComponent("/w/billing")}`);
      }
      if (error.isNotFound) notFound();
    }
    throw error;
  }

  const parsed = parseBillingState(state);
  if (parsed === null) {
    return { status: "unavailable" };
  }
  return {
    status: "ready",
    payload: {
      workspaceId: membership.workspaceId,
      workspaceName: membership.workspace.name,
      canManage: membership.role === "owner" || membership.role === "admin",
      state: parsed,
      // W1-e tail (M9 recovery): the REAL `GET /v1/billing/invoices` read
      // (M6-D's recorded history). Invoices are secondary history — a
      // failure here degrades to an empty list, never a broken page.
      invoices: await loadInvoiceRows(membership.workspaceId),
    },
  };
}

/**
 * One `GET /v1/billing/invoices` page → view rows. Tolerant by design:
 * malformed/unavailable history renders as an empty table (the ledger link
 * remains the source of truth for every money movement).
 */
async function loadInvoiceRows(workspaceId: string): Promise<readonly BillingInvoiceRow[]> {
  try {
    const page = await gatewayCall<unknown>("/v1/billing/invoices?limit=25", {
      workspaceId,
    });
    const items =
      typeof page === "object" &&
      page !== null &&
      Array.isArray((page as { items?: unknown }).items)
        ? ((page as { items: unknown[] }).items ?? [])
        : [];
    const rows: BillingInvoiceRow[] = [];
    for (const item of items) {
      if (typeof item !== "object" || item === null) continue;
      const row = item as Record<string, unknown>;
      if (
        typeof row.id !== "string" ||
        typeof row.amountCents !== "number" ||
        typeof row.currency !== "string" ||
        typeof row.status !== "string" ||
        typeof row.createdAt !== "string"
      ) {
        continue;
      }
      rows.push({
        id: row.id,
        date: row.createdAt,
        amountCents: row.amountCents,
        currency: row.currency,
        status: row.status as BillingInvoiceRow["status"],
        hostedUrl: typeof row.hostedUrl === "string" ? row.hostedUrl : null,
        pdfUrl: typeof row.pdfUrl === "string" ? row.pdfUrl : null,
      });
    }
    return rows;
  } catch {
    return [];
  }
}

export default async function BillingPage({ searchParams }: BillingPageProps) {
  const { ws } = await searchParams;

  let resolution: BillingResolution;
  try {
    resolution = await loadBillingPage(ws);
  } catch (error) {
    if (isGatewayHttpError(error) && (error.status === 401 || error.code === "UNAUTHORIZED")) {
      redirect(`/sign-in?next=${encodeURIComponent("/w/billing")}`);
    }
    throw error;
  }

  if (resolution.status === "empty") {
    return (
      <main id="main" className="flex min-h-svh items-center justify-center bg-app px-5">
        <EmptyState
          data-testid="billing-no-workspace"
          title="You don't belong to a workspace yet."
          secondaryLink={{ label: "Back to the site", href: "/" }}
        />
      </main>
    );
  }

  if (resolution.status === "unavailable") {
    return (
      <main id="main" className="flex min-h-svh items-center justify-center bg-app px-5">
        <EmptyState
          data-testid="billing-unavailable"
          title="Billing is unavailable right now."
          secondaryLink={{ label: "Back to workspace", href: "/w" }}
        />
      </main>
    );
  }

  const { workspaceId, workspaceName, canManage, state, invoices } = resolution.payload;
  return (
    <BillingPageView
      workspaceId={workspaceId}
      workspaceName={workspaceName}
      canManage={canManage}
      initialState={state}
      invoices={invoices}
      nowIso={new Date().toISOString()}
    />
  );
}
