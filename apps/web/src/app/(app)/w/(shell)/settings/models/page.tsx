import { EmptyState } from "@studio/ui";
import { notFound, redirect } from "next/navigation";

import { ModelsPreferencesView } from "@/components/settings/models-preferences-view";
import { gatewayCall } from "@/lib/gateway";
import { pageMetadata } from "@/lib/seo";
import {
  classifyGatewayError,
  parseMemberships,
  resolveActiveWorkspace,
  signInPath,
} from "@/lib/workspace-membership";

/**
 * The models & preferences route (UI_DESIGN_SYSTEM §8.9 "Models" +
 * "Preferences"; W2-07 web half).
 *
 * `/w/settings/models` — the RSC arm resolves the workspace (the shared `?ws`
 * semantics; explicit-but-unknown → 404, hard rule 3) and hands the client
 * view (`components/settings/models-preferences-view.tsx`) the workspace id.
 * The view owns: `GET /v1/models` (the §8.2 entitlement surface behind the
 * default-model radio), the D-22 auto-apply toggle (GET/PATCH /v1/me/settings
 * — USER-scoped, not workspace; the W3-G2 seam), the chat layout reset
 * (ECUX §2.5) and the dark-only honest note.
 *
 * Every member sees the surface (models.list is viewer-floored; auto-apply is
 * per-user) — no role gating here.
 */

export const metadata = pageMetadata({
  title: "Models & preferences",
  description: "Default model, auto-apply and chat preferences.",
  path: "/w/settings/models",
});

const PAGE_PATH = "/w/settings/models";

interface ModelsPageProps {
  readonly searchParams: Promise<{ readonly ws?: string }>;
}

export default async function ModelsPage({ searchParams }: ModelsPageProps) {
  const { ws } = await searchParams;

  let me: unknown;
  try {
    me = await gatewayCall<unknown>("/v1/me");
  } catch (error) {
    const verdict = classifyGatewayError(error, PAGE_PATH);
    if (verdict.action === "sign-in") redirect(signInPath(verdict.next));
    if (verdict.action === "not-found") notFound();
    throw verdict.error;
  }

  const resolution = resolveActiveWorkspace(parseMemberships(me), ws);
  if (resolution.status === "no-workspace") {
    return (
      <main id="main" className="flex min-h-svh items-center justify-center bg-app px-5">
        <EmptyState
          data-testid="models-no-workspace"
          title="You don't belong to a workspace yet."
          secondaryLink={{ label: "Back to the site", href: "/" }}
        />
      </main>
    );
  }
  if (resolution.status === "unknown-workspace") notFound();

  const membership = resolution.membership;
  return (
    <main id="main" className="min-h-svh bg-app px-5 py-10">
      <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-6">
        <header className="flex flex-col gap-1">
          <h1 className="text-title-l font-medium text-primary">Models &amp; preferences</h1>
          <p className="text-body-s text-muted">
            Defaults for {membership.workspace.name} and your own chat preferences.
          </p>
        </header>
        <ModelsPreferencesView workspaceId={membership.workspaceId} />
      </div>
    </main>
  );
}
