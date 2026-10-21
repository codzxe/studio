"use client";

// Placeholder auth form (W1-K). This posts a stub to the gateway's
// Better Auth endpoints (§13.1 `POST /v1/auth/*`) via plain fetch.
//
// TODO(W4 auth wiring): replace this stub with the Better Auth client
// (`better-auth/react`), which handles the session cookie, CSRF, OAuth and
// magic links; until then this only proves the transport + error envelope
// contract in src/lib/api.ts unwrapping style. Keep user-facing strings
// free of internal names (docs/AGENTS.md branding rules).

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { getClientEnv } from "@/lib/env";

type AuthMode = "sign-in" | "sign-up";

interface AuthFormProps {
  readonly mode: AuthMode;
}

interface ErrorEnvelopeLike {
  readonly message?: string;
}

const isSignUp = (mode: AuthMode): boolean => mode === "sign-up";

export function AuthForm({ mode }: AuthFormProps) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      // Lazy env read: fails fast with a clear message if NEXT_PUBLIC_
      // vars are missing (src/lib/env.ts), and never runs at build time.
      const { apiBaseUrl } = getClientEnv();
      const path = isSignUp(mode) ? "/auth/sign-up/email" : "/auth/sign-in/email";
      const body = isSignUp(mode)
        ? { name, email, password }
        : { email, password };
      const response = await fetch(`${apiBaseUrl}${path}`, {
        method: "POST",
        credentials: "include", // §13: session cookie
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const envelope = (await response.json().catch(() => null)) as
          | ErrorEnvelopeLike
          | null;
        setError(envelope?.message ?? "Something went wrong. Please try again.");
        return;
      }
      setDone(true);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <p
        className="max-w-sm rounded-lg border border-border bg-surface p-6 text-center text-sm text-muted-foreground"
      >
        You&apos;re in. The workspace opens here once sign-in is fully wired.
      </p>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-surface p-6"
    >
      <h1 className="text-lg font-semibold">
        {isSignUp(mode) ? "Create your account" : "Sign in"}
      </h1>

      {isSignUp(mode) ? (
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Name</span>
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            autoComplete="name"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
      ) : null}

      <label className="block text-sm">
        <span className="mb-1 block font-medium">Email</span>
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
          autoComplete="email"
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </label>

      <label className="block text-sm">
        <span className="mb-1 block font-medium">Password</span>
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
          minLength={isSignUp(mode) ? 8 : undefined}
          autoComplete={isSignUp(mode) ? "new-password" : "current-password"}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </label>

      {error === null ? null : (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting
          ? "Please wait…"
          : isSignUp(mode)
            ? "Create account"
            : "Sign in"}
      </button>

      <p className="text-center text-xs text-muted-foreground">
        {isSignUp(mode) ? "Already have an account? " : "New here? "}
        <Link
          href={isSignUp(mode) ? "/sign-in" : "/sign-up"}
          className="font-medium text-foreground underline underline-offset-2"
        >
          {isSignUp(mode) ? "Sign in" : "Create an account"}
        </Link>
      </p>
    </form>
  );
}
