import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";

import { type ShellEntitlements, AppShell, type ShellPayload } from "@/components/shell/app-shell";
import { gatewayCall, isGatewayHttpError } from "@/lib/gateway";
import {
  classifyGatewayError,
  parseMemberships,
  signInPath,
  type WorkspaceMembership,
} from "@/lib/workspace-membership";

/**
 * ShellLayout (W2-01, §8.4) — the RSC half of the SaaS shell, shared by the
 * `(shell)` route groups:
 *
 * - `app/(app)/w/(shell)/layout.tsx` → `/w`, `/w/billing`, `/w/projects`,
 *   `/w/settings/*` (the Wave-3 pages mount straight into the shell);
 * - `app/(app)/w/[slug]/(shell)/layout.tsx` → `/w/[slug]/history` (the hub).
 *
 * The editor route `/w/[slug]/editor` stays OUTSIDE both groups (§8.7 hard
 * rule: full-bleed editor, no rail, no ⌘K shell listener).
 *
 * Resolution (the billing/history page pattern, via lib/workspace-membership):
 * `GET /v1/me → memberships`; expired session → `/sign-in?next=/w` (layouts
 * do not receive the pathname — the round-trip lands on the workspace root);
 * NO membership → `/onboarding` (first-run journey, W2-02). The DEFAULT
 * workspace is the FIRST membership; `GET /v1/billing/state` for it supplies
 * credits + entitlements. Layouts do not receive searchParams either (App
 * Router contract) — `?ws` stays page-authoritative server-side and the
 * client shell refines the display (see app-shell.tsx).
 *
 * Billing degrade policy: a 401 mid-load still redirects (the session is
 * gone); ANY other billing failure (404 race, 5xx, malformed payload) →
 * `credits/entitlements: null` — the shell is chrome, the pages own their
 * 404/empty semantics, and navigation never breaks on a secondary read.
 */

// ---------------------------------------------------------------------------
// Wire shape guard for `GET /v1/billing/state` (apps/web never runtime-imports
// the contracts barrel; this restates the two subshapes the shell consumes)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Finite non-negative number, or null (hostile wire never renders). */
function countOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

const ENTITLEMENT_FIELDS = [
  "seats",
  "maxProjects",
  "storageBytes",
  "renderMinutesPerMonth",
  "monthlyCreditAllowance",
] as const;

/** The shell's slice of the billing state: credits + entitlements, or null. */
function parseShellBilling(
  value: unknown,
): { readonly credits: { balance: number; reserved: number }; readonly entitlements: ShellEntitlements } | null {
  if (!isRecord(value)) return null;
  const credits = isRecord(value.credits) ? value.credits : null;
  if (
    credits === null ||
    typeof credits.balance !== "number" ||
    typeof credits.reserved !== "number" ||
    !Number.isFinite(credits.balance) ||
    !Number.isFinite(credits.reserved)
  ) {
    return null;
  }
  const entitlements = isRecord(value.entitlements) ? value.entitlements : null;
  if (entitlements === null) return null;
  if (!Array.isArray(entitlements.models) || entitlements.models.some((m) => typeof m !== "string")) {
    return null;
  }
  const numbers: Record<(typeof ENTITLEMENT_FIELDS)[number], number> = {
    seats: 0,
    maxProjects: 0,
    storageBytes: 0,
    renderMinutesPerMonth: 0,
    monthlyCreditAllowance: 0,
  };
  for (const field of ENTITLEMENT_FIELDS) {
    const parsed = countOrNull(entitlements[field]);
    if (parsed === null) return null;
    numbers[field] = parsed;
  }
  return {
    credits: { balance: credits.balance, reserved: credits.reserved },
    entitlements: {
      seats: numbers.seats,
      models: entitlements.models,
      maxProjects: numbers.maxProjects,
      storageBytes: numbers.storageBytes,
      renderMinutesPerMonth: numbers.renderMinutesPerMonth,
      monthlyCreditAllowance: numbers.monthlyCreditAllowance,
    },
  };
}

/** The user block of `/v1/me` — tolerant (malformed → empty-string degrade). */
function parseShellUser(value: unknown): ShellPayload["user"] {
  const user = isRecord(value) && isRecord(value.user) ? value.user : {};
  return {
    id: typeof user.id === "string" ? user.id : "",
    name: typeof user.name === "string" ? user.name : null,
    email: typeof user.email === "string" ? user.email : "",
  };
}

// ---------------------------------------------------------------------------
// The layout
// ---------------------------------------------------------------------------

/** The sign-in round-trip target (layouts cannot see the current path). */
const SIGN_IN_NEXT = "/w";

function fail(error: unknown): never {
  const verdict = classifyGatewayError(error, SIGN_IN_NEXT);
  if (verdict.action === "sign-in") redirect(signInPath(verdict.next));
  if (verdict.action === "not-found") notFound();
  throw verdict.error;
}

export async function ShellLayout({ children }: { readonly children: ReactNode }) {
  let me: unknown;
  try {
    me = await gatewayCall<unknown>("/v1/me");
  } catch (error) {
    fail(error);
  }

  const memberships = parseMemberships(me);
  if (memberships.length === 0) {
    // First-run journey (W2-02): create a workspace before entering /w.
    redirect("/onboarding");
  }
  const active: WorkspaceMembership | undefined = memberships[0];

  let billing:
    | {
        readonly credits: { readonly balance: number; readonly reserved: number };
        readonly entitlements: ShellEntitlements;
      }
    | null = null;
  if (active !== undefined) {
    try {
      const state = await gatewayCall<unknown>("/v1/billing/state", {
        workspaceId: active.workspaceId,
      });
      billing = parseShellBilling(state);
    } catch (error) {
      // Session death mid-load still redirects; anything else degrades the
      // credits area (the pages beneath own their own 404 semantics).
      if (isGatewayHttpError(error) && (error.status === 401 || error.code === "UNAUTHORIZED")) {
        redirect(signInPath(SIGN_IN_NEXT));
      }
      billing = null;
    }
  }

  if (active === undefined) {
    // Unreachable (memberships.length > 0 checked above) — honest 404, never
    // a crash (law #1).
    notFound();
  }

  const payload: ShellPayload = {
    user: parseShellUser(me),
    memberships,
    activeWorkspaceId: active.workspaceId,
    activeWorkspaceSlug: active.workspace.slug,
    credits: billing?.credits ?? null,
    entitlements: billing?.entitlements ?? null,
  };

  return <AppShell payload={payload}>{children}</AppShell>;
}
