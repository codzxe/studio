"use client";

import { authClient } from "@/lib/auth-client";
import { useOnlineStatus } from "@/lib/use-online-status";
import { Button, Input } from "@studio/ui";
import { MailCheck } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useState } from "react";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Forgot-password (§8.2): one email field → requestPasswordReset; the success
 * state is honest — it does NOT confirm the account exists (no user
 * enumeration).
 */
export function ForgotPasswordForm() {
  const online = useOnlineStatus();
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextEmailError = EMAIL_PATTERN.test(email) ? null : "Enter a valid email address.";
    setEmailError(nextEmailError);
    if (nextEmailError) {
      return;
    }

    // Offline gate (M9-H, §8.11): don't fire a request the browser can't send.
    if (!online) {
      setEmailError("You're offline. Reconnect and we'll send the reset link.");
      return;
    }

    setSubmitting(true);
    const redirectTo = `${window.location.origin}/reset-password`;
    authClient
      .requestPasswordReset({ email, redirectTo })
      .then(({ error }) => {
        setSubmitting(false);
        if (error) {
          setEmailError(error.message ?? "Couldn't send the reset email. Try again in a moment.");
          return;
        }
        setSent(true);
      })
      .catch(() => {
        setSubmitting(false);
        setEmailError("Couldn't send the reset email — the service may be unreachable.");
      });
  }

  if (sent) {
    return (
      <div className="flex flex-col gap-6" data-testid="forgot-password-sent">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-pill border border-border bg-panel text-success">
            <MailCheck size={20} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <h1 className="font-display text-display-m text-balance text-primary">
            Check your inbox.
          </h1>
        </div>
        <p className="text-body-s leading-relaxed text-secondary">
          If an account exists for that address, a reset link is on its way. The link expires
          shortly — reset from the email and pick a new password.
        </p>
        <div className="flex flex-col gap-2 text-body-s">
          <Link
            href="/sign-in"
            className="self-start text-primary underline underline-offset-3 transition-colors duration-120 hover:text-signal"
          >
            Back to sign in
          </Link>
          <button
            type="button"
            onClick={() => {
              setSent(false);
              setEmail("");
            }}
            className="self-start text-secondary underline underline-offset-3 transition-colors duration-120 hover:text-signal"
          >
            Used the wrong address?
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8" data-testid="forgot-password-form">
      <div className="flex flex-col gap-3">
        <h1 className="font-display text-display-m text-balance text-primary">
          Reset your password.
        </h1>
        <p className="text-body-s text-secondary">
          Enter the email you signed up with and we&apos;ll send a reset link.
        </p>
      </div>

      <form className="flex flex-col gap-5" onSubmit={onSubmit} noValidate>
        <Input
          id="forgot-password-email"
          type="email"
          label="Email"
          autoComplete="email"
          inputSize="lg"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          error={emailError}
          required
        />
        <Button type="submit" size="lg" className="w-full" loading={submitting}>
          Send reset link
        </Button>
      </form>

      <p className="text-body-s text-muted">
        Remembered it?{" "}
        <Link
          href="/sign-in"
          className="text-primary underline underline-offset-3 transition-colors duration-120 hover:text-signal"
        >
          Sign in
        </Link>
      </p>
    </div>
  );
}
