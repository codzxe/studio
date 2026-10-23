"use client";

import { OAuthButtons } from "@/components/auth/oauth-buttons";
import { PasswordField } from "@/components/auth/password-field";
import { formatMonthlyPrice } from "@/components/billing/page-format";
import { authClient } from "@/lib/auth-client";
import { useOnlineStatus } from "@/lib/use-online-status";
import { Brand, PLAN_CATALOG } from "@studio/config";
import { Button, Input } from "@studio/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The D-4 trial copy (§8.2) — sentence shape VERBATIM, both numbers DERIVED
 * from PLAN_CATALOG (W5-03, same derivation as onboarding's TrialStep and
 * /pricing's TrialBlock): the trial is a state on the Starter row, so the
 * "then" price is Starter's monthly price and the free length is the trial
 * row's trialDays. The stale hardcoded "$29/mo" (pre-pivot pricing that
 * contradicted the catalog's Starter price) can never come back.
 */
const TRIAL_COPY = `${PLAN_CATALOG.trial.trialDays} days free, then ${formatMonthlyPrice(
  PLAN_CATALOG.starter.monthlyPriceCents,
)}. Card required today. Cancel anytime.`;

/**
 * Sign-up form (§8.2): name, email, password, terms checkbox — unchecked by
 * default, no marketing opt-in. Trial copy stated up front, card included.
 */
export function SignUpForm() {
  const router = useRouter();
  const online = useOnlineStatus();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [termsError, setTermsError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextNameError =
      name.trim().length >= 2 ? null : "Tell us your name — two characters or more.";
    const nextEmailError = EMAIL_PATTERN.test(email) ? null : "Enter a valid email address.";
    const nextPasswordError =
      password.length >= 8 ? null : "Password must be at least 8 characters.";
    const nextTermsError = acceptedTerms ? null : "You need to accept the terms to continue.";
    setNameError(nextNameError);
    setEmailError(nextEmailError);
    setPasswordError(nextPasswordError);
    setTermsError(nextTermsError);
    setFormError(null);
    if (nextNameError || nextEmailError || nextPasswordError || nextTermsError) {
      return;
    }

    // Offline gate (M9-H, §8.11): don't fire a sign-up the browser can't send.
    if (!online) {
      setFormError("You're offline. Reconnect and try again — no account was created.");
      return;
    }

    setSubmitting(true);
    authClient.signUp
      .email({ name: name.trim(), email, password })
      .then(({ error }) => {
        if (error) {
          if (error.code === "USER_ALREADY_EXISTS") {
            setEmailError("An account already exists for this email. Sign in instead?");
          }
          setFormError(error.message ?? "Couldn't create the account. Try again in a moment.");
          setSubmitting(false);
          return;
        }
        router.push("/onboarding");
        router.refresh();
      })
      .catch(() => {
        setFormError("Sign-up failed — the service may be unreachable. Try again in a moment.");
        setSubmitting(false);
      });
  }

  return (
    <div className="flex flex-col gap-8" data-testid="sign-up-form">
      <div className="flex flex-col gap-3">
        <h1 className="font-display text-display-m text-balance text-primary">
          Create your workspace.
        </h1>
        <p className="text-body-s text-secondary" data-testid="sign-up-trial-copy">
          {TRIAL_COPY}
        </p>
      </div>

      <OAuthButtons callbackURL="/w" />

      <div className="flex items-center gap-4" aria-hidden="true">
        <span className="h-px flex-1 bg-border" />
        <span className="text-caption text-muted">or continue with email</span>
        <span className="h-px flex-1 bg-border" />
      </div>

      <form className="flex flex-col gap-5" onSubmit={onSubmit} noValidate>
        <Input
          id="sign-up-name"
          type="text"
          label="Name"
          autoComplete="name"
          inputSize="lg"
          value={name}
          onChange={(event) => setName(event.target.value)}
          error={nameError}
          required
        />
        <Input
          id="sign-up-email"
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
          id="sign-up-password"
          label="Password"
          autoComplete="new-password"
          helperText="At least 8 characters."
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          error={passwordError}
          required
        />

        <div className="flex flex-col gap-2">
          <div className="flex items-start gap-3">
            <input
              id="sign-up-terms"
              type="checkbox"
              checked={acceptedTerms}
              onChange={(event) => setAcceptedTerms(event.target.checked)}
              aria-describedby={termsError ? "sign-up-terms-error" : undefined}
              aria-invalid={termsError ? true : undefined}
              data-testid="sign-up-terms"
              className="mt-1 h-4 w-4 shrink-0 accent-(--signal)"
            />
            <label htmlFor="sign-up-terms" className="text-body-s leading-relaxed text-secondary">
              I accept the{" "}
              <Link
                href="/legal/terms"
                className="text-primary underline underline-offset-3 transition-colors duration-120 hover:text-signal"
              >
                terms of service
              </Link>{" "}
              and the{" "}
              <Link
                href="/legal/privacy"
                className="text-primary underline underline-offset-3 transition-colors duration-120 hover:text-signal"
              >
                privacy policy
              </Link>
              .
            </label>
          </div>
          {termsError ? (
            <p id="sign-up-terms-error" role="alert" className="text-caption text-danger">
              {termsError}
            </p>
          ) : null}
        </div>

        {formError ? (
          <p role="alert" className="text-caption text-danger">
            {formError}
          </p>
        ) : null}

        <Button type="submit" size="lg" className="w-full" loading={submitting}>
          Create account
        </Button>
      </form>

      <p className="text-body-s text-muted">
        Already have a workspace?{" "}
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
