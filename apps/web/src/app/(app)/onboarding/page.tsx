import { redirect } from "next/navigation";

import { OnboardingFlow } from "@/components/onboarding/onboarding-flow";
import { gatewayCall, isGatewayHttpError } from "@/lib/gateway";
import { pageMetadata } from "@/lib/seo";

/**
 * The first-run onboarding route (BUILD_PLAN §M9 task 3; UI_DESIGN_SYSTEM
 * §8.3; manifest W2-02 — the AUD-1 gap).
 *
 * ONE server read (`GET /v1/me`) through the RSC gateway seam decides
 * everything before the client flow mounts:
 *
 * - Expired session → `/sign-in` with a `next` round-trip (the proxy only
 *   guards `/w/*`; this route does its own auth check via the gateway).
 * - The user ALREADY belongs to a workspace → `/w` (invited users and
 *   returning accounts never re-run onboarding — `invite-card.tsx` correctly
 *   lands them on `/w` directly).
 * - Otherwise → the three-step flow (`components/onboarding/`): Workspace →
 *   Use case → Start. The workspace is created at step 1 (`POST
 *   /v1/workspaces`), so an abandoned flow self-heals: the next visit to
 *   `/onboarding` sees the membership and redirects to `/w`.
 *
 * Wire shapes are hand-guarded here (apps/web never runtime-imports the
 * contracts barrel — `lib/gateway.ts` boundary law); a malformed `/v1/me`
 * degrades to "no memberships" and renders the flow, the same tolerance the
 * billing page applies (never a stack, law #1).
 */

export const metadata = pageMetadata({
  title: "Create your workspace",
  description: "Name your workspace, tell us what you make, and start creating.",
  path: "/onboarding",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Same wire guard as the billing page (`/v1/me → memberships`), reduced to
 * what this route needs: does the caller belong to ANY workspace? Only fully
 * valid rows count — malformed input never fakes a redirect.
 */
function hasMembership(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.memberships)) return false;
  for (const raw of value.memberships) {
    if (!isRecord(raw) || !isRecord(raw.workspace)) continue;
    if (typeof raw.workspaceId !== "string") continue;
    if (typeof raw.workspace.id !== "string") continue;
    if (typeof raw.workspace.name !== "string") continue;
    if (typeof raw.workspace.slug !== "string") continue;
    if (typeof raw.role !== "string") continue;
    return true;
  }
  return false;
}

export default async function OnboardingPage() {
  let me: unknown;
  try {
    me = await gatewayCall<unknown>("/v1/me");
  } catch (error) {
    if (isGatewayHttpError(error) && (error.status === 401 || error.code === "UNAUTHORIZED")) {
      redirect(`/sign-in?next=${encodeURIComponent("/onboarding")}`);
    }
    throw error;
  }

  // Already a member (invited, returning, or an abandoned flow that already
  // created its workspace) — the dashboard is the right landing spot.
  if (hasMembership(me)) {
    redirect("/w");
  }

  return (
    <main id="main" className="flex min-h-svh items-center justify-center bg-app px-5 py-16">
      <OnboardingFlow />
    </main>
  );
}
