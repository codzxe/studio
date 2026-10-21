"use client";

// Sign-up form (W8-B; replaces the W1-K stub) — Better Auth `signUp.email`
// against the gateway contract (§15.2 emailAndPassword enabled;
// requireEmailVerification is off until the email wave, so sign-up yields a
// live session immediately). The gateway's databaseHooks provision a personal
// workspace right after the user row lands (apps/gateway/src/auth/server.ts)
// and activate it on the session — so /dashboard has an active organization
// from the first render (§20 #1: sign-up → workspace).
// Success redirects to ?next= (invite round-trip) or /dashboard; errors
// display typed from the flat envelope via toAuthFormError (src/lib/auth.ts).

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import {
  authClient,
  POST_AUTH_PATH,
  safePostAuthPath,
  toAuthFormError,
  type AuthFormError,
} from "@/lib/auth";
import { AuthError } from "./auth-error";

const inputClasses =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function SignUpForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = safePostAuthPath(searchParams.get("next"));

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<AuthFormError | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const { error: authError } = await authClient.signUp.email({
        name,
        email,
        password,
      });
      if (authError !== null && authError !== undefined) {
        setError(toAuthFormError(authError));
        return;
      }
      // Session cookie + freshly provisioned personal workspace are live;
      // the (app) shell takes it from here.
      router.replace(nextPath);
    } catch (cause) {
      setError(toAuthFormError(cause));
    } finally {
      setSubmitting(false);
    }
  }

  const signInHref =
    nextPath === POST_AUTH_PATH
      ? "/sign-in"
      : `/sign-in?next=${encodeURIComponent(nextPath)}`;

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <h1 className="text-lg font-semibold">Create your account</h1>

      <label className="block text-sm">
        <span className="mb-1 block font-medium">Name</span>
        <input
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          autoComplete="name"
          className={inputClasses}
        />
      </label>

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
          minLength={8}
          autoComplete="new-password"
          className={inputClasses}
        />
      </label>

      {error === null ? null : <AuthError error={error} />}

      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? "Please wait…" : "Create account"}
      </button>

      <p className="text-center text-xs text-muted-foreground">
        Already have an account?{" "}
        <Link
          href={signInHref}
          className="font-medium text-foreground underline underline-offset-2"
        >
          Sign in
        </Link>
      </p>
    </form>
  );
}
