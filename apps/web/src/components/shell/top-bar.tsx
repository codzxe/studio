"use client";

/**
 * TopBar (W2-01, §8.4) — the shell's 56px sticky top bar.
 *
 * `[dot] Studio | <Workspace ▾> … [Search projects…] [12.35 credits ▓▓░] [AJ]`
 *
 * - Workspace switcher (Menu, §7.6): every membership with its role; picking
 *   one calls `members.switchWorkspace` (the session-scoped active org) and
 *   navigates to the SAME path with `?ws=<slug>` — the seam every `/w` page
 *   resolves server-side (lib/workspace-membership). A typed failure lands in
 *   a §7.7 danger toast; navigation never happens on failure.
 * - SearchInput is the palette trigger (§7.2: leading icon + ⌘K hint) — the
 *   field itself is read-only and focuses the ⌘K palette, where typing lives.
 * - Credits: the numeric balance ALWAYS visible (§7.11 — never colour-only)
 *   as the top-up link into `/w/billing`, plus the compact CreditMeter of
 *   the monthly allowance. RAW µc in, D-12 2-decimal credits out (the same
 *   billing-kit converters the billing page uses). When billing state is
 *   unavailable the area degrades to a quiet "Billing" link — the shell
 *   never blocks on a secondary read.
 * - Avatar (initials only — no fake avatars) + account Menu: the caller's
 *   email and sign-out via `authClient.signOut` → `/`.
 */

import { isApiError } from "@studio/api-client";
import { Brand } from "@studio/config";
import type { BillingState, Page, Project, SwitchedWorkspace } from "@studio/contracts";
import {
  Avatar,
  CreditMeter,
  Menu,
  MenuContent,
  MenuItem,
  MenuItemShortcut,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
  SearchInput,
} from "@studio/ui";
import { Check, ChevronsUpDown, LogOut } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { authClient } from "@/lib/auth-client";
import type { WorkspaceMembership } from "@/lib/workspace-membership";
import { formatCreditsDisplay, microcreditsToCreditsDisplay } from "../billing/ledger-table";
import { useShellToast } from "./use-shell-toast";

// ---------------------------------------------------------------------------
// The api seam — a narrow port the real ApiClient satisfies structurally
// (the asBillingPort pattern; AppShell builds it per active workspace)
// ---------------------------------------------------------------------------

/** The shell's gateway surface. Production: `asShellPort(workspaceId)`. */
export interface ShellPort {
  /** POST /v1/workspaces/:id/switch — set the session's active workspace. */
  readonly members: {
    readonly switchWorkspace: (workspaceId: string) => Promise<SwitchedWorkspace>;
  };
  /** GET /v1/billing/state — credits + entitlements (the ?ws refetch). */
  readonly billing: {
    readonly state: () => Promise<BillingState>;
  };
  /** GET /v1/projects — the palette's Projects group. */
  readonly projects: {
    readonly list: (query?: { readonly limit?: number }) => Promise<Page<Project>>;
  };
}

// ---------------------------------------------------------------------------
// Display helpers (D-12: RAW µc in → 2-decimal credits out)
// ---------------------------------------------------------------------------

/** µc balance → "12.35"; hostile input → "—" (never renders a lie). */
export function formatShellCredits(microcredits: number): string {
  return formatCreditsDisplay(microcreditsToCreditsDisplay(microcredits));
}

/**
 * µc → credits for the CreditMeter's numeric props (D-12). The billing-kit
 * converter answers null on hostile input (never a lie); the meter needs a
 * number, so it degrades to 0 there — the meter is decorative next to the
 * ALWAYS-visible numeric link above (§7.11), which renders "—" honestly.
 */
function meterCredits(microcredits: number): number {
  return microcreditsToCreditsDisplay(microcredits) ?? 0;
}

/** Avatar name: the display name, or the email handle (initials fallback). */
function avatarName(name: string | null, email: string): string {
  if (name !== null && name.trim() !== "") return name;
  const handle = email.split("@")[0] ?? email;
  return handle.trim() !== "" ? handle : "?";
}

/** The §7.3-safe one-liner for a failed action (message + hint, no ids). */
function failureLine(error: unknown): string {
  if (isApiError(error)) {
    return error.hint === undefined ? error.message : `${error.message} ${error.hint}`;
  }
  return "Try again in a moment.";
}

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------

export interface TopBarProps {
  readonly email: string;
  readonly userName: string | null;
  readonly memberships: readonly WorkspaceMembership[];
  readonly activeMembership: WorkspaceMembership;
  /** RAW µc balance/reserved, or null when billing state is unavailable. */
  readonly credits: { readonly balance: number; readonly reserved: number } | null;
  /** The allowance side of the meter (µc); null hides the meter. */
  readonly monthlyAllowanceMicrocredits: number | null;
  /** Opens the ⌘K command palette. */
  readonly onOpenPalette: () => void;
  /** Injectable port (tests). Production builds it from createApiClient. */
  readonly port: ShellPort;
  /** Injectable sign-out (tests); default wraps `authClient.signOut`. */
  readonly signOut?: () => Promise<void>;
}

export function TopBar({
  email,
  userName,
  memberships,
  activeMembership,
  credits,
  monthlyAllowanceMicrocredits,
  onOpenPalette,
  port,
  signOut,
}: TopBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const toast = useShellToast();
  const [switching, setSwitching] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const activeId = activeMembership.workspaceId;

  async function switchWorkspace(membership: WorkspaceMembership): Promise<void> {
    if (switching || membership.workspaceId === activeId) return;
    setSwitching(true);
    try {
      await port.members.switchWorkspace(membership.workspaceId);
      const params = new URLSearchParams(searchParams.toString());
      params.set("ws", membership.workspace.slug);
      router.push(`${pathname}?${params.toString()}`);
    } catch (error) {
      // §7.7: transient failure → toast, never a decision dialog.
      toast.show({
        variant: "danger",
        title: "Couldn't switch workspace.",
        description: failureLine(error),
      });
    } finally {
      setSwitching(false);
    }
  }

  async function handleSignOut(): Promise<void> {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await (signOut ?? defaultSignOut)();
      router.push("/");
    } catch (error) {
      toast.show({
        variant: "danger",
        title: "Couldn't sign out.",
        description: failureLine(error),
      });
      setSigningOut(false);
    }
  }

  return (
    <header
      data-testid="shell-top-bar"
      className="sticky top-0 z-40 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-app px-4 md:gap-4 md:px-5"
    >
      <Link
        href="/w"
        aria-label={`${Brand.productName} — dashboard`}
        className="flex shrink-0 items-center gap-2.5"
      >
        {/* §2.3 the signal dot — small accent, never a glowing orb. */}
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-pill bg-signal" />
        <span className="hidden font-display text-title-m leading-none text-primary sm:inline">
          {Brand.productName}
        </span>
      </Link>

      <Menu>
        <MenuTrigger asChild>
          <button
            type="button"
            data-testid="workspace-switcher"
            aria-label={`Workspace: ${activeMembership.workspace.name}. Switch workspace.`}
            className="flex h-9 min-w-0 max-w-56 shrink items-center gap-2 rounded-sm border border-border bg-input px-3 text-body-s text-primary transition-colors duration-120 hover:border-border-strong"
          >
            <span className="truncate">{activeMembership.workspace.name}</span>
            <ChevronsUpDown
              size={16}
              strokeWidth={1.75}
              aria-hidden="true"
              className="shrink-0 text-muted"
            />
          </button>
        </MenuTrigger>
        <MenuContent align="start" aria-label="Switch workspace">
          <MenuLabel>Workspaces</MenuLabel>
          {memberships.map((membership) => {
            const active = membership.workspaceId === activeId;
            return (
              <MenuItem
                key={membership.workspaceId}
                disabled={switching}
                data-testid={`switcher-${membership.workspace.slug}`}
                onSelect={() => {
                  void switchWorkspace(membership);
                }}
              >
                {active ? (
                  <Check size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
                ) : (
                  <span aria-hidden="true" className="w-4 shrink-0" />
                )}
                <span className="max-w-44 truncate">{membership.workspace.name}</span>
                <MenuItemShortcut>{membership.role}</MenuItemShortcut>
              </MenuItem>
            );
          })}
        </MenuContent>
      </Menu>

      <div className="ml-auto flex shrink-0 items-center gap-3 md:gap-4">
        <SearchInput
          className="hidden w-64 md:block"
          shortcut="⌘K"
          aria-label="Search projects and commands"
          placeholder="Search projects…"
          data-testid="topbar-search"
          readOnly
          value=""
          onFocus={onOpenPalette}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onOpenPalette();
            }
          }}
        />

        {credits === null ? (
          <Link
            href="/w/billing"
            data-testid="topbar-credits-unavailable"
            className="text-body-s text-muted transition-colors duration-120 hover:text-primary"
          >
            Billing
          </Link>
        ) : (
          <div data-testid="topbar-credits" className="flex items-center gap-3">
            <Link
              href="/w/billing"
              aria-label={`Credits balance ${formatShellCredits(credits.balance)} — open billing`}
              className="tabular text-body-s text-primary transition-colors duration-120 hover:text-secondary"
            >
              {formatShellCredits(credits.balance)}{" "}
              <span className="text-muted max-md:hidden">credits</span>
            </Link>
            {monthlyAllowanceMicrocredits === null ? null : (
              <CreditMeter
                used={Math.max(
                  meterCredits(monthlyAllowanceMicrocredits) - meterCredits(credits.balance),
                  0,
                )}
                included={meterCredits(monthlyAllowanceMicrocredits)}
                className="hidden w-28 lg:flex"
              />
            )}
          </div>
        )}

        <Menu>
          <MenuTrigger asChild>
            <button
              type="button"
              data-testid="account-menu"
              aria-label="Account menu"
              aria-haspopup="menu"
              className="rounded-pill transition-colors duration-120 hover:border-border-strong"
            >
              <Avatar name={avatarName(userName, email)} size="md" />
            </button>
          </MenuTrigger>
          <MenuContent align="end" aria-label="Account">
            <MenuLabel>
              <span className="block max-w-52 truncate normal-case tracking-normal">{email}</span>
            </MenuLabel>
            <MenuSeparator />
            <MenuItem
              data-testid="sign-out"
              disabled={signingOut}
              onSelect={() => {
                void handleSignOut();
              }}
            >
              <LogOut size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
              Sign out
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
    </header>
  );
}

/** Default sign-out: the better-auth client's signOut ({data,error} shape). */
async function defaultSignOut(): Promise<void> {
  const { error } = await authClient.signOut();
  if (error) {
    throw new Error(error.message === undefined ? "Sign out failed." : error.message);
  }
}
