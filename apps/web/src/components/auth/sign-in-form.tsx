"use client";

import { OAuthButtons } from "@/components/auth/oauth-buttons";
import { PasswordField } from "@/components/auth/password-field";
import { authClient } from "@/lib/auth-client";
import { useOnlineStatus } from "@/lib/use-online-status";
import { Brand } from "@studio/config";
import { Button, Input } from "@studio/ui";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useState } from "react";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Sign-in form (§8.2): OAuth first, email divider, email + password with
 * show/hide, forgot link, inline errors (never toasts), ?next= round-trip.
 */
export function SignInForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? "/w";
  // M9-H: /reset-password sends the user here with ?reset=1 after a
  // successful password change — surfaced as an inline success note.
  const passwordReset = searchParams.get("reset") === "1";
  const online = useOnlineStatus();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Inline validation first (§8.2 — errors inline, not toasts).
    const nextEmailError = EMAIL_PATTERN.test(email) ? null : "Enter a valid email address.";
    const nextPasswordError =
      password.length >= 8 ? null : "Password must be at least 8 characters.";
    setEmailError(nextEmailError);
    setPasswordError(nextPasswordError);
    setFormError(null);
    if (nextEmailError || nextPasswordError) {
      return;
    }

    // Offline gate (M9-H, §8.11): don't fire a sign-in the browser can't send.
    if (!online) {
      setFormError("You're offline. Reconnect and sign in once you're back online.");
      return;
    }

    setSubmitting(true);
    authClient.signIn
      .email({ email, password })
      .then(({ error }) => {
        if (error) {
          setFormError(
            error.code === "INVALID_EMAIL_OR_PASSWORD" || error.code === "USER_NOT_FOUND"
              ? "That email and password combination doesn't match an account."
              : (error.message ?? "Sign-in failed. Try again in a moment."),
          );
          setSubmitting(false);
          return;
        }
        router.push(next);
        router.refresh();
      })
      .catch(() => {
        setFormError("Sign-in failed — the service may be unreachable. Try again in a moment.");
        setSubmitting(false);
      });
  }

  return (
    <div className="flex flex-col gap-8" data-testid="sign-in-form">
      {passwordReset ? (
        <output
          data-testid="sign-in-reset-note"
          className="block rounded-md border border-border bg-panel px-4 py-3 text-body-s text-success"
        >
          Password updated. Sign in with your new password.
        </output>
      ) : null}
      <h1 className="font-display text-display-m text-balance text-primary">
        Sign in to {Brand.productName}.
      </h1>

      <OAuthButtons callbackURL={next} />

      <div className="flex items-center gap-4" aria-hidden="true">
        <span className="h-px flex-1 bg-border" />
        <span className="text-caption text-muted">or continue with email</span>
        <span className="h-px flex-1 bg-border" />
      </div>

      <form className="flex flex-col gap-5" onSubmit={onSubmit} noValidate>
        <Input
          id="sign-in-email"
          type="email"
          label="Email"
          autoComplete="email"
          inputSize="lg"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          error={emailError}
          required
        />
        <PasswordField
          id="sign-in-password"
          label="Password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          error={passwordError}
          required
        />

        {formError ? (
          <p role="alert" className="text-caption text-danger">
            {formError}
          </p>
        ) : null}

        <Button type="submit" size="lg" className="w-full" loading={submitting}>
          Sign in
        </Button>
      </form>

      <div className="flex flex-col gap-2 text-body-s">
        <Link
          href="/forgot-password"
          className="self-start text-secondary underline underline-offset-3 transition-colors duration-120 hover:text-signal"
        >
          Forgot password?
        </Link>
        <p className="text-muted">
          New to {Brand.productName}?{" "}
          <Link
            href="/sign-up"
            className="text-primary underline underline-offset-3 transition-colors duration-120 hover:text-signal"
          >
            Create your workspace
          </Link>
        </p>
      </div>
    </div>
  );
}
