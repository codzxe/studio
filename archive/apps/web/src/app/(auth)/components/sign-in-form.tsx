"use client";

// Sign-in form (W8-B; replaces the W1-K stub) — the real Better Auth flow
// against the gateway contract (§15.2: email+password enabled in
// apps/gateway/src/auth/server.ts). Two methods, one tab set:
//  - Password: `authClient.signIn.email` — the gateway sets the httpOnly
//    session cookie (§15.2); success redirects to ?next= (invite round-trip)
//    or /dashboard, the (app) route.
//  - Magic link: better-auth's magic-link API (`authClient.signIn.magicLink`
//    — the client method inferred from the /sign-in/magic-link endpoint).
//    TODO(gateway, email wave): the server plugin is not mounted yet, so the
//    tab surfaces the typed envelope error until apps/gateway enables it.
// Errors display typed from the flat envelope via toAuthFormError
// (src/lib/auth.ts); better-auth client calls resolve { data, error } and
// never throw — the catch arm is belt-and-braces only.

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent, type KeyboardEvent } from "react";
import {
  authClient,
  POST_AUTH_PATH,
  safePostAuthPath,
  toAuthFormError,
  type AuthFormError,
} from "@/lib/auth";
import { AuthError } from "./auth-error";

const PASSWORD_TAB = "password";
const MAGIC_LINK_TAB = "magic-link";

type SignInMethod = typeof PASSWORD_TAB | typeof MAGIC_LINK_TAB;

const inputClasses =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function SignInForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = safePostAuthPath(searchParams.get("next"));

  const [method, setMethod] = useState<SignInMethod>(PASSWORD_TAB);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<AuthFormError | null>(null);
  const [magicLinkSent, setMagicLinkSent] = useState(false);

  function selectMethod(next: SignInMethod): void {
    setMethod(next);
    setError(null);
    setMagicLinkSent(false);
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    // ARIA tabs: Arrow keys move between the two tabs.
    if (event.key === "ArrowRight") {
      selectMethod(MAGIC_LINK_TAB);
    } else if (event.key === "ArrowLeft") {
      selectMethod(PASSWORD_TAB);
    }
  }

  async function signInWithPassword(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const { error: authError } = await authClient.signIn.email({ email, password });
      if (authError !== null && authError !== undefined) {
        setError(toAuthFormError(authError));
        return;
      }
      // The (app) shell boots with the session cookie now in the jar.
      router.replace(nextPath);
    } catch (cause) {
      setError(toAuthFormError(cause));
    } finally {
      setSubmitting(false);
    }
  }

  async function signInWithMagicLink(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      // better-auth magic-link API: email in, one-time link out; clicking it
      // verifies and lands on callbackURL with a live session. The callback
      // is absolute because the gateway (not this app) renders the link.
      const { error: authError } = await authClient.signIn.magicLink({
        email,
        callbackURL: `${window.location.origin}${nextPath}`,
      });
      if (authError !== null && authError !== undefined) {
        setError(toAuthFormError(authError));
        return;
      }
      setMagicLinkSent(true);
    } catch (cause) {
      setError(toAuthFormError(cause));
    } finally {
      setSubmitting(false);
    }
  }

  const signUpHref =
    nextPath === POST_AUTH_PATH
      ? "/sign-up"
      : `/sign-up?next=${encodeURIComponent(nextPath)}`;

  return (
    <div className="space-y-5">
      <h1 className="text-lg font-semibold">Sign in</h1>

      <div
        role="tablist"
        aria-label="Sign-in method"
        onKeyDown={onTabKeyDown}
        className="grid grid-cols-2 gap-1 rounded-md bg-surface-muted p-1"
      >
        <button
          type="button"
          role="tab"
          aria-selected={method === PASSWORD_TAB}
          onClick={() => selectMethod(PASSWORD_TAB)}
          className={`rounded-sm px-3 py-1.5 text-sm font-medium transition ${
            method === PASSWORD_TAB
              ? "bg-surface text-foreground"
              : "text-muted-foreground"
          }`}
        >
          Password
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={method === MAGIC_LINK_TAB}
          onClick={() => selectMethod(MAGIC_LINK_TAB)}
          className={`rounded-sm px-3 py-1.5 text-sm font-medium transition ${
            method === MAGIC_LINK_TAB
              ? "bg-surface text-foreground"
              : "text-muted-foreground"
          }`}
        >
          Magic link
        </button>
      </div>

      {method === MAGIC_LINK_TAB && magicLinkSent ? (
        <p className="rounded-md border border-border bg-surface-muted p-4 text-sm text-muted-foreground">
          If an account exists for {email}, a one-time sign-in link is on its way.
          Click it to open your workspace.
        </p>
      ) : method === MAGIC_LINK_TAB ? (
        <form onSubmit={signInWithMagicLink} className="space-y-4">
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Email</span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              autoComplete="email"
              className={inputClasses}
            />
          </label>
          {error === null ? null : <AuthError error={error} />}
          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Please wait…" : "Email me a sign-in link"}
          </button>
        </form>
      ) : (
        <form onSubmit={signInWithPassword} className="space-y-4">
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Email</span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              autoComplete="email"
              className={inputClasses}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              autoComplete="current-password"
              className={inputClasses}
            />
          </label>
          {error === null ? null : <AuthError error={error} />}
          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Please wait…" : "Sign in"}
          </button>
        </form>
      )}

      <p className="text-center text-xs text-muted-foreground">
        New here?{" "}
        <Link
          href={signUpHref}
          className="font-medium text-foreground underline underline-offset-2"
        >
          Create an account
        </Link>
      </p>
    </div>
  );
}
