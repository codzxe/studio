"use client";

// components/shell/user-menu — topbar account menu (W8-A).
//
// Shows the placeholder identity from GET /v1/me (null until the auth wave
// wires it) and signs out via POST /v1/auth/sign-out. Keyboard + ARIA wiring
// lives in ./use-menu. TODO(W8-B): Better Auth client owns the session.

import { ChevronsUpDown, LogOut } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { useSession, useSignOut, type SessionFetchState } from "@/hooks/use-session";
import { useMenu } from "./use-menu";

const TRIGGER_CLASS =
  "flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const MENU_PANEL_CLASS =
  "absolute right-0 top-full z-50 mt-1 w-60 rounded-md border border-border bg-surface p-1 shadow-md";

const ITEM_CLASS =
  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function UserMenu() {
  const { user, userState } = useSession();
  const signOut = useSignOut();
  const menu = useMenu();
  const triggerId = useId();
  const [message, setMessage] = useState<string | null>(null);

  const identity = user?.name ?? user?.email ?? "";
  const displayName = resolveDisplayName(identity, userState.status);
  const initials = initialsOf(identity === "" ? "You" : identity);

  async function handleSignOut(): Promise<void> {
    const result = await signOut.signOut();
    if (!result.ok) {
      setMessage(result.message);
    }
  }

  return (
    <div className="relative">
      <button
        ref={menu.triggerRef}
        id={triggerId}
        type="button"
        {...menu.triggerProps}
        className={TRIGGER_CLASS}
      >
        <span
          aria-hidden="true"
          className="grid size-6 shrink-0 place-items-center rounded-full bg-surface-muted text-[10px] font-semibold text-foreground"
        >
          {initials}
        </span>
        <span className="hidden min-w-0 max-w-32 truncate text-sm font-medium sm:inline">
          {displayName}
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>
      {menu.open ? (
        <div
          ref={menu.menuRef}
          {...menu.menuProps}
          aria-labelledby={triggerId}
          className={MENU_PANEL_CLASS}
        >
          <div className="min-w-0 border-b border-border px-2 py-2">
            <p className="truncate text-sm font-medium">{displayName}</p>
            {user?.email !== undefined ? (
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{user.email}</p>
            ) : (
              <p className="mt-0.5 text-xs text-muted-foreground">
                Session details appear once sign-in is wired.
              </p>
            )}
          </div>
          {user === null && userState.status !== "loading" ? (
            <Link
              ref={(element) => {
                menu.registerItem(0, element);
              }}
              href="/sign-in"
              role="menuitem"
              onClick={() => {
                menu.closeMenu();
              }}
              className={ITEM_CLASS}
            >
              Sign in
            </Link>
          ) : null}
          <button
            ref={(element) => {
              menu.registerItem(1, element);
            }}
            type="button"
            role="menuitem"
            onClick={() => {
              void handleSignOut();
            }}
            disabled={signOut.pending}
            className={`${ITEM_CLASS} disabled:cursor-not-allowed disabled:opacity-50`}
          >
            <LogOut className="size-4 shrink-0" aria-hidden="true" />
            {signOut.pending ? "Signing out…" : "Sign out"}
          </button>
          {message !== null ? (
            <p role="alert" className="px-2 py-1.5 text-xs text-red-600">
              {message}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Two-letter avatar initials; degrades gracefully for email-only identities. */
function initialsOf(value: string): string {
  const letters = value
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
  return letters === "" ? "?" : letters;
}

function resolveDisplayName(identity: string, status: SessionFetchState["status"]): string {
  if (status === "loading") {
    return "Account";
  }
  return identity === "" ? "You" : identity;
}
