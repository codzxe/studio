import { EmptyState } from "@studio/ui";
import { notFound, redirect } from "next/navigation";

import { AuditLogView } from "@/components/settings/audit-log-view";
import { gatewayCall } from "@/lib/gateway";
import { pageMetadata } from "@/lib/seo";
import {
  classifyGatewayError,
  parseMemberships,
  resolveActiveWorkspace,
  signInPath,
} from "@/lib/workspace-membership";

/**
 * The audit route (UI_DESIGN_SYSTEM §8.9 "Audit"; W2-07 web half).
 *
 * `/w/settings/audit` — the RSC arm resolves the workspace (the shared
 * `?ws` semantics; explicit-but-unknown → 404, hard rule 3) and hands the
 * client view (`components/settings/audit-log-view.tsx`) the workspace id.
 * The log itself (cursor pages, the server-side targetType filter, the
 * client-side action filter, the bounded CSV export) is the view's, through
 * the SettingsPort's `listAudit` — the GET /v1/workspaces/:id/audit seam
 * (W3-G2 lands the gateway route + api-client namespace this wave; the port
 * degrades honestly until the sync).
 *
 * Every workspace member can read the log (the route's viewer floor mirrors
 * the project activity feed) — no role gating here.
 */

export const metadata = pageMetadata({
  title: "Audit log",
  description: "Who did what across this workspace.",
  path: "/w/settings/audit",
});

const PAGE_PATH = "/w/settings/audit";

interface AuditPageProps {
  readonly searchParams: Promise<{ readonly ws?: string }>;
}

export default async function AuditPage({ searchParams }: AuditPageProps) {
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
          data-testid="audit-no-workspace"
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
          <h1 className="text-title-l font-medium text-primary">Audit log</h1>
          <p className="text-body-s text-muted">
            Every audited action in {membership.workspace.name} — filterable, exportable.
          </p>
        </header>
        <AuditLogView workspaceId={membership.workspaceId} nowIso={new Date().toISOString()} />
      </div>
    </main>
  );
}
