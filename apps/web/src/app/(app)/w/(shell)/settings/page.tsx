import { EmptyState } from "@studio/ui";
import { notFound, redirect } from "next/navigation";

import { GeneralForm } from "@/components/settings/general-form";
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
 * The General settings route (W2-06, §8.9): `/w/settings`.
 *
 * ONE server-side read (`GET /v1/me → memberships`, through the shared
 * workspace-membership seam) resolves the workspace — `?ws=<id or slug>`
 * wins; no `?ws` → the first membership; an explicit-but-unknown `?ws` is a
 * 404 (hard rule 3: cross-tenant = 404, never 403). The membership row
 * already carries the workspace name/slug this page displays; every mutation
 * (`workspaces.patch`) lives in the client form through `@studio/api-client`
 * same-origin with the workspace header.
 *
 * - Expired session → `/sign-in` with a `next` round-trip.
 * - No membership → the honest empty state (unreachable in practice — the
 *   shell layout redirects no-workspace users to `/onboarding` first).
 * - Name/slug edits render for owners/admins only — the gateway's
 *   `manageWorkspace` capability; other members read.
 */

export const metadata = pageMetadata({
  title: "General settings",
  description: "Your workspace name and slug.",
  path: "/w/settings",
});

/** The sign-in round-trip target (this page's canonical path). */
const PAGE_PATH = "/w/settings";

type GeneralResolution =
  | { readonly status: "empty" }
  | {
      readonly status: "ready";
      readonly payload: {
        readonly workspaceId: string;
        readonly workspaceName: string;
        readonly workspaceSlug: string;
        readonly canManage: boolean;
      };
    };

async function loadGeneralPage(ws: string | undefined): Promise<GeneralResolution> {
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
  if (resolution.status === "unknown-workspace") {
    notFound();
  }
  if (resolution.status === "no-workspace") {
    return { status: "empty" };
  }

  const { membership } = resolution;
  return {
    status: "ready",
    payload: {
      workspaceId: membership.workspaceId,
      workspaceName: membership.workspace.name,
      workspaceSlug: membership.workspace.slug,
      canManage: canManageWorkspace(membership.role),
    },
  };
}

interface GeneralPageProps {
  readonly searchParams: Promise<{ readonly ws?: string }>;
}

export default async function GeneralSettingsPage({ searchParams }: GeneralPageProps) {
  const { ws } = await searchParams;
  const resolution = await loadGeneralPage(ws);

  if (resolution.status === "empty") {
    return (
      <EmptyState
        data-testid="settings-no-workspace"
        title="You don't belong to a workspace yet."
        secondaryLink={{ label: "Back to the site", href: "/" }}
      />
    );
  }

  const { workspaceId, workspaceName, workspaceSlug, canManage } = resolution.payload;
  return (
    <GeneralForm
      workspaceId={workspaceId}
      workspaceName={workspaceName}
      workspaceSlug={workspaceSlug}
      canManage={canManage}
    />
  );
}
