"use client";

import { PasswordField } from "@/components/auth/password-field";
import { authClient } from "@/lib/auth-client";
import { useOnlineStatus } from "@/lib/use-online-status";
import { Button } from "@studio/ui";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useState } from "react";

const MIN_PASSWORD_LENGTH = 8;

/**
 * Reset password (M9-H, closes the AUD-5 dead link): better-auth's
 * /reset-password/:token GET callback validates the emailed token, then
 * redirects here with `?token=…` — or `?error=INVALID_TOKEN` when the token
 * is expired/used (verified against installed better-auth 1.7.12,
 * dist/api/routes/password.mjs:124-127). The form then POSTs
 * authClient.resetPassword({ newPassword, token }) and sends the user to
 * sign-in with a success note (`/sign-in?reset=1`).
 *
 * All failures are honest per §14: what happened, why, what to do — a
 * missing token never fakes a form, and an invalid token says so.
 */
export function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const online = useOnlineStatus();
  const token = searchParams.get("token");
  const linkError = searchParams.get("error");

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // The emailed link was rejected by better-auth's callback redirect.
  if (!token && linkError) {
    return (
      <div className="flex flex-col gap-6" data-testid="reset-password-invalid">
        <h1 className="font-display text-display-m text-balance text-primary">
          This reset link doesn&apos;t work anymore.
        </h1>
        <p className="text-body-s leading-relaxed text-secondary">
          The link has expired or was already used. Reset links are single-use and expire about an
          hour after they&apos;re sent. Request a fresh one — it only takes a moment.
        </p>
        <Link
          href="/forgot-password"
          className="self-start text-primary underline underline-offset-3 transition-colors duration-120 hover:text-signal"
        >
          Request a new reset link
        </Link>
      </div>
    );
  }

  // No token in the URL: there is nothing to reset against — never fake a form.
  if (!token) {
    return (
      <div className="flex flex-col gap-6" data-testid="reset-password-missing-token">
        <h1 className="font-display text-display-m text-balance text-primary">
          This page needs a reset link.
        </h1>
        <p className="text-body-s leading-relaxed text-secondary">
          Resetting your password starts from a link in your inbox. Open the full link from your
          reset email, or request a fresh one below.
        </p>
        <Link
          href="/forgot-password"
          className="self-start text-primary underline underline-offset-3 transition-colors duration-120 hover:text-signal"
        >
          Request a reset link
        </Link>
      </div>
    );
  }

  // token is non-null past the early returns — capture the narrowed value so
  // the submit closure below sees `string`, not `string | null`.
  const resetToken = token;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextPasswordError =
      newPassword.length >= MIN_PASSWORD_LENGTH
        ? null
        : `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    const nextConfirmError =
      confirmPassword === newPassword ? null : "The two passwords don't match.";
    setPasswordError(nextPasswordError);
    setConfirmError(nextConfirmError);
    setFormError(null);
    if (nextPasswordError || nextConfirmError) {
      return;
    }

    // Offline gate (§8.11): don't fire a request the browser can't send.
    if (!online) {
      setFormError("You're offline. Reconnect — your new password hasn't been changed yet.");
      return;
    }

    setSubmitting(true);
    authClient
      .resetPassword({ newPassword, token: resetToken })
      .then(({ error }) => {
        setSubmitting(false);
        if (error) {
          setFormError(
            error.code === "INVALID_TOKEN"
              ? "This reset link has expired or was already used. Request a fresh one to continue."
              : (error.message ?? "Couldn't reset the password. Try again in a moment."),
          );
          return;
        }
        router.push("/sign-in?reset=1");
        router.refresh();
      })
      .catch(() => {
        setSubmitting(false);
        setFormError("Couldn't reset the password — the service may be unreachable.");
      });
  }

  return (
    <div className="flex flex-col gap-8" data-testid="reset-password-form">
      <div className="flex flex-col gap-3">
        <h1 className="font-display text-display-m text-balance text-primary">
          Pick a new password.
        </h1>
        <p className="text-body-s text-secondary">
          Your reset link is valid. Choose a new password for your account.
        </p>
      </div>

      <form className="flex flex-col gap-5" onSubmit={onSubmit} noValidate>
        <PasswordField
          id="reset-password-new"
          label="New password"
          autoComplete="new-password"
          helperText={`At least ${MIN_PASSWORD_LENGTH} characters.`}
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          error={passwordError}
          required
        />
        <PasswordField
          id="reset-password-confirm"
          label="Confirm new password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          error={confirmError}
          required
        />

        {formError ? (
          <p role="alert" className="text-caption text-danger">
            {formError}
          </p>
        ) : null}

        <Button type="submit" size="lg" className="w-full" loading={submitting}>
          Reset password
        </Button>
      </form>

      <p className="text-body-s text-muted">
        Didn&apos;t mean to reset?{" "}
        <Link
          href="/sign-in"
          className="text-primary underline underline-offset-3 transition-colors duration-120 hover:text-signal"
        >
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
