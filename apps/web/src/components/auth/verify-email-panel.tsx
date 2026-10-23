"use client";

import { authClient } from "@/lib/auth-client";
import { useOnlineStatus } from "@/lib/use-online-status";
import { Button, Spinner } from "@studio/ui";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Email verification panel (M9-H): reads `?token=…` and verifies it via
 * better-auth's client (`authClient.verifyEmail` — GET /verify-email, method
 * name + query shape verified against installed better-auth 1.7.12,
 * dist/api/routes/email-verification.mjs:125-131). We deliberately pass no
 * `callbackURL` so the server answers with JSON instead of a redirect — the
 * page owns its own verifying → success/failure states.
 *
 * Server state today (honest v1): better-auth's emailVerification option is
 * NOT enabled in packages/db/src/auth.ts — no mail transport exists in the
 * gateway, so no verification emails are sent and enabling it without one
 * would fake the journey. The endpoint itself still works, so this page is
 * complete and future-proof: `?error=…` failures redirected by the server
 * are handled, and VERIFICATION_EMAIL_NOT_ENABLED surfaces an honest
 * "not switched on yet — nothing is blocked" state instead of a dead end.
 */

type Phase = "verifying" | "success" | "failure" | "idle";

interface FailureCopy {
  heading: string;
  body: string;
}

/** §14 error copy per better-auth code: what happened, why, what to do. */
const FAILURE_COPY: Record<string, FailureCopy> = {
  INVALID_TOKEN: {
    heading: "This verification link doesn't work anymore.",
    body: "The link is invalid, expired, or was already used. You can still sign in with your email and password as normal.",
  },
  TOKEN_EXPIRED: {
    heading: "This verification link expired.",
    body: "Verification links expire about an hour after they're sent. You can still sign in with your email and password as normal.",
  },
  USER_NOT_FOUND: {
    heading: "No account matches this link anymore.",
    body: "The account may have been deleted. Sign in with your usual email, or create a workspace if you're new.",
  },
  VERIFICATION_EMAIL_NOT_ENABLED: {
    heading: "Email verification isn't switched on here yet.",
    body: "Nothing is blocked — you can sign in with your email and password while we finish wiring this up.",
  },
};

const FALLBACK_FAILURE: FailureCopy = {
  heading: "Couldn't verify this email.",
  body: "Something went wrong on our side, not yours. Try the link again, or sign in — email verification isn't required to use Studio.",
};

const SIGN_IN_LINK = (
  <Link
    href="/sign-in"
    className="self-start text-primary underline underline-offset-3 transition-colors duration-120 hover:text-signal"
  >
    Sign in
  </Link>
);

export function VerifyEmailPanel() {
  const searchParams = useSearchParams();
  const online = useOnlineStatus();
  const token = searchParams.get("token");
  const linkError = searchParams.get("error");

  const [phase, setPhase] = useState<Phase>(token ? "verifying" : "idle");
  const [failure, setFailure] = useState<FailureCopy | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const verify = useCallback(() => {
    if (!token) {
      // The server already rejected the link and redirected here with ?error=…
      if (linkError) {
        setFailure(FAILURE_COPY[linkError] ?? FALLBACK_FAILURE);
        setPhase("failure");
      } else {
        setPhase("idle");
      }
      return;
    }

    setUnreachable(false);
    setPhase("verifying");
    authClient
      .verifyEmail({ query: { token } })
      .then(({ error }) => {
        if (!mounted.current) {
          return;
        }
        if (error) {
          setFailure(FAILURE_COPY[error.code ?? ""] ?? FALLBACK_FAILURE);
          setPhase("failure");
          return;
        }
        setPhase("success");
      })
      .catch(() => {
        if (!mounted.current) {
          return;
        }
        setUnreachable(true);
        setPhase("failure");
      });
  }, [token, linkError]);

  useEffect(() => {
    verify();
  }, [verify]);

  if (phase === "verifying") {
    return (
      <div className="flex flex-col items-center gap-4 py-16" data-testid="verify-email-verifying">
        <Spinner size={24} label="Verifying your email" />
        <p className="text-body-s text-muted">Verifying your email…</p>
      </div>
    );
  }

  if (phase === "success") {
    return (
      <div className="flex flex-col gap-6" data-testid="verify-email-success">
        <h1 className="font-display text-display-m text-balance text-primary">Email verified.</h1>
        <p className="text-body-s leading-relaxed text-secondary">
          Your email address is confirmed. Sign in to pick up where you left off.
        </p>
        {SIGN_IN_LINK}
      </div>
    );
  }

  if (phase === "failure") {
    // Network-level failure: the request never reached the server, so the
    // token is still unspent — a retry is always the honest next action,
    // whether the browser is still offline or the connection just came back.
    if (unreachable) {
      return (
        <div className="flex flex-col gap-6" data-testid="verify-email-failure">
          <h1 className="font-display text-display-m text-balance text-primary">
            {online ? "Couldn't reach Studio." : "You're offline."}
          </h1>
          <p className="text-body-s leading-relaxed text-secondary">
            {online
              ? "The verification request didn't make it through. Check your connection and try again — nothing was changed on your account."
              : "The verification request couldn't leave your browser. Reconnect, then try again — nothing was changed on your account."}
          </p>
          <Button variant="primary" size="lg" onClick={verify}>
            Try again
          </Button>
        </div>
      );
    }

    return (
      <div className="flex flex-col gap-6" data-testid="verify-email-failure">
        <h1 className="font-display text-display-m text-balance text-primary">
          {failure?.heading ?? FALLBACK_FAILURE.heading}
        </h1>
        <p className="text-body-s leading-relaxed text-secondary">
          {failure?.body ?? FALLBACK_FAILURE.body}
        </p>
        {SIGN_IN_LINK}
      </div>
    );
  }

  // Bare visit — nothing to verify. Honest, and no dead end.
  return (
    <div className="flex flex-col gap-6" data-testid="verify-email-idle">
      <h1 className="font-display text-display-m text-balance text-primary">
        Nothing to verify here.
      </h1>
      <p className="text-body-s leading-relaxed text-secondary">
        Open the full verification link from your inbox — or sign in directly. Email verification
        isn&apos;t required to use Studio.
      </p>
      {SIGN_IN_LINK}
    </div>
  );
}
