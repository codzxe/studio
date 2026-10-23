import { EmptyState } from "@studio/ui";
import { notFound, redirect } from "next/navigation";

import { ApiKeysView } from "@/components/settings/api-keys-view";
import { gatewayCall } from "@/lib/gateway";
import { pageMetadata } from "@/lib/seo";
import {
  canManageWorkspace,
  classifyGatewayError,
  parseMemberships,
  resolveActiveWorkspace,
  signInPath,
} from "@/lib/workspace-membership";

/**
 * The API keys route (UI_DESIGN_SYSTEM §8.9 "API keys"; W2-07 web half).
 *
 * `/w/settings/api-keys` — the RSC arm resolves the workspace
 * (`GET /v1/me → memberships`, honoring `?ws=<id or slug>`; explicit-but-
 * unknown `?ws` is a 404, hard rule 3) and hands the client view
 * (`components/settings/api-keys-view.tsx`) the workspace id + the
 * owner/admin role bit. Every read and mutation (list/create/revoke, the
 * show-once key panel) is the view's, through the SettingsPort.
 *
 * The sibling W2-06 lands `settings/layout.tsx` (the left sub-nav) this
 * wave; until then the page mounts straight into the app shell (same URLs).
 */

export const metadata = pageMetadata({
  title: "API keys",
  description: "Create, inspect and revoke workspace API keys.",
  path: "/w/settings/api-keys",
});

const PAGE_PATH = "/w/settings/api-keys";

interface ApiKeysPageProps {
  readonly searchParams: Promise<{ readonly ws?: string }>;
}

export default async function ApiKeysPage({ searchParams }: ApiKeysPageProps) {
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
          data-testid="api-keys-no-workspace"
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
          <h1 className="text-title-l font-medium text-primary">API keys</h1>
          <p className="text-body-s text-muted">
            Scoped keys for {membership.workspace.name} — hashed at rest, revocable.
          </p>
        </header>
        <ApiKeysView
          workspaceId={membership.workspaceId}
          canManage={canManageWorkspace(membership.role)}
          nowIso={new Date().toISOString()}
        />
      </div>
    </main>
  );
}
