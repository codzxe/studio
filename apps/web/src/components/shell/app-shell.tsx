"use client";

/**
 * AppShell (W2-01, §8.4) — the SaaS shell's client root.
 *
 * The RSC layout (`app/(app)/w/(shell)/layout.tsx`) resolves the session
 * server-side (`GET /v1/me` + `GET /v1/billing/state` for the default
 * workspace) and hands over ONE serializable {@link ShellPayload}; this
 * component owns every interaction:
 *
 * - the left {@link WorkspaceRail} (240↔64px, persisted collapse);
 * - the sticky {@link TopBar} (switcher / search trigger / credits / account);
 * - the {@link ShellCommandPalette} behind ⌘K (D-5 — shell only; the editor
 *   route never mounts this tree);
 * - the {@link OfflineBanner} (renders null while online);
 * - the {@link ShellToastHost} (toasts mounted exactly once).
 *
 * `?ws=<id or slug>` refinement: layouts do not receive searchParams (App
 * Router contract), so the server payload always describes the DEFAULT
 * workspace (first membership). When the URL carries a `?ws` that maps to a
 * different membership, the shell adopts it for display and refetches
 * `billing.state` through the workspace-scoped port — the PAGES still resolve
 * `?ws` authoritatively server-side (they 404 an unknown one; the shell just
 * falls back to the default while the page's 404 renders).
 */

import { type ApiClient, createApiClient } from "@studio/api-client";
import type { BillingState } from "@studio/contracts";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

import type { WorkspaceMembership } from "@/lib/workspace-membership";
import { OfflineBanner } from "./offline-banner";
import { ShellCommandPalette } from "./shell-command-palette";
import type { ShellPort } from "./top-bar";
import { TopBar } from "./top-bar";
import { ShellToastHost } from "./use-shell-toast";
import { WorkspaceRail } from "./workspace-rail";

// ---------------------------------------------------------------------------
// The serializable payload (the RSC layout → client shell contract)
// ---------------------------------------------------------------------------

/** `GET /v1/me` → user (§7.2 wire). */
export interface ShellUser {
  readonly id: string;
  readonly name: string | null;
  readonly email: string;
}

/** RAW ledger numbers in integer microcredits (D-12 — converted at display). */
export interface ShellCredits {
  readonly balance: number;
  readonly reserved: number;
}

/** The entitlement bundle the meter needs (§7.11; allowance in µc). */
export interface ShellEntitlements {
  readonly seats: number;
  readonly models: readonly string[];
  readonly maxProjects: number;
  readonly storageBytes: number;
  readonly renderMinutesPerMonth: number;
  readonly monthlyCreditAllowance: number;
}

/** Everything the shell renders from — server-fetched, JSON-serializable. */
export interface ShellPayload {
  readonly user: ShellUser;
  readonly memberships: readonly WorkspaceMembership[];
  readonly activeWorkspaceId: string;
  readonly activeWorkspaceSlug: string;
  /** Null when billing state was unavailable/malformed (honest degrade). */
  readonly credits: ShellCredits | null;
  readonly entitlements: ShellEntitlements | null;
}

// ---------------------------------------------------------------------------
// The production port (same-origin /v1 + x-workspace-id — asBillingPort
// pattern: a narrow surface the real ApiClient satisfies structurally)
// ---------------------------------------------------------------------------

/** Same-origin API root (Caddy fronts `/v1` in production — README §Env). */
const API_BASE_URL = "/v1";

/**
 * Compile-time pin (and adapter): the production `ApiClient` satisfies the
 * shell's {@link ShellPort} — the shell never hand-rolls a call.
 */
export function asShellPort(client: ApiClient): ShellPort {
  return {
    members: { switchWorkspace: (workspaceId) => client.members.switchWorkspace(workspaceId) },
    billing: { state: () => client.billing.state() },
    projects: { list: (query) => client.projects.list(query) },
  };
}

/** Builds the production port for one workspace page load. */
export function createShellPort(workspaceId: string): ShellPort {
  return asShellPort(
    createApiClient({ baseUrl: API_BASE_URL, headers: { "x-workspace-id": workspaceId } }),
  );
}

/** ?ws matching (client-side mirror of lib/workspace-membership). */
function matchMembership(
  memberships: readonly WorkspaceMembership[],
  candidate: string | null,
): WorkspaceMembership | null {
  if (candidate === null) return null;
  return (
    memberships.find(
      (membership) =>
        membership.workspaceId === candidate ||
        membership.workspace.id === candidate ||
        membership.workspace.slug === candidate,
    ) ?? null
  );
}

/** Narrow the billing state to the shell's credit/entitlement view. */
function toShellBilling(
  state: BillingState,
): { credits: ShellCredits; entitlements: ShellEntitlements } {
  return {
    credits: { balance: state.credits.balance, reserved: state.credits.reserved },
    entitlements: {
      seats: state.entitlements.seats,
      models: state.entitlements.models,
      maxProjects: state.entitlements.maxProjects,
      storageBytes: state.entitlements.storageBytes,
      renderMinutesPerMonth: state.entitlements.renderMinutesPerMonth,
      monthlyCreditAllowance: state.entitlements.monthlyCreditAllowance,
    },
  };
}

// ---------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------

export interface AppShellProps {
  readonly payload: ShellPayload;
  /** Injectable port factory (tests); default = createShellPort. */
  readonly createPort?: (workspaceId: string) => ShellPort;
  readonly children: ReactNode;
}

export function AppShell({ payload, createPort, children }: AppShellProps) {
  const searchParams = useSearchParams();
  const [paletteOpen, setPaletteOpen] = useState(false);

  const defaultMembership = useMemo(
    () =>
      payload.memberships.find((m) => m.workspaceId === payload.activeWorkspaceId) ??
      payload.memberships[0],
    [payload.memberships, payload.activeWorkspaceId],
  );

  // The ?ws override (page-authoritative server-side; display-only here).
  const wsMembership = matchMembership(payload.memberships, searchParams.get("ws"));
  const active = wsMembership ?? defaultMembership;

  // Credits follow the ACTIVE workspace: the server payload when it matches,
  // a client-side refetch when ?ws points elsewhere.
  const [credits, setCredits] = useState<ShellCredits | null>(payload.credits);
  const [entitlements, setEntitlements] = useState<ShellEntitlements | null>(payload.entitlements);
  useEffect(() => {
    setCredits(payload.credits);
    setEntitlements(payload.entitlements);
  }, [payload.credits, payload.entitlements]);
  useEffect(() => {
    if (active === null || active.workspaceId === payload.activeWorkspaceId) return;
    let cancelled = false;
    const port = createPort?.(active.workspaceId) ?? createShellPort(active.workspaceId);
    port.billing
      .state()
      .then((state) => {
        if (cancelled) return;
        const view = toShellBilling(state);
        setCredits(view.credits);
        setEntitlements(view.entitlements);
      })
      .catch(() => {
        if (!cancelled) {
          setCredits(null);
          setEntitlements(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [active, payload.activeWorkspaceId, createPort]);

  // The active workspace's port (switcher + palette).
  const port = useMemo(
    () =>
      active === null
        ? null
        : (createPort?.(active.workspaceId) ?? createShellPort(active.workspaceId)),
    [active, createPort],
  );

  // ⌘K / Ctrl+K toggles the palette (D-5; shell-only mount — never the editor).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const openPalette = useCallback(() => setPaletteOpen(true), []);

  if (defaultMembership === undefined || active === null || port === null) {
    // Unreachable in practice (the layout redirects no-membership users to
    // /onboarding); rendered defensively, never as a crash.
    return <div className="min-h-svh bg-app">{children}</div>;
  }

  return (
    <ShellToastHost>
      <div data-testid="app-shell" className="flex min-h-svh flex-col bg-app">
        <TopBar
          email={payload.user.email}
          userName={payload.user.name}
          memberships={payload.memberships}
          activeMembership={active}
          credits={credits}
          monthlyAllowanceMicrocredits={entitlements?.monthlyCreditAllowance ?? null}
          onOpenPalette={openPalette}
          port={port}
        />
        <div className="flex min-h-0 flex-1">
          <WorkspaceRail />
          <div data-testid="shell-content" className="min-w-0 flex-1">
            <OfflineBanner />
            {children}
          </div>
        </div>
      </div>
      <ShellCommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        port={port}
      />
    </ShellToastHost>
  );
}
