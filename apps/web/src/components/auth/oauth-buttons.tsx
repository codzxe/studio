"use client";

import { authClient } from "@/lib/auth-client";
import { Button, cn } from "@studio/ui";
import { useState } from "react";

/**
 * OAuth row (§8.2): Google + GitHub, full width, 44px (lg), brand marks in
 * monochrome (currentColor — no colour marks on the dark shell). Clicking
 * hands off to better-auth's social sign-in (full-page redirect to the
 * provider; the gateway resolves the callback).
 */

/** Monochrome Google "G" — official mark paths, drawn with currentColor. */
function GoogleMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={cn("h-4 w-4 shrink-0 text-primary", className)}
      fill="currentColor"
    >
      <path d="M12 11v2.9h6.8c-.3 1.8-2 5.3-6.8 5.3-4.1 0-7.4-3.4-7.4-7.6S7.9 4 12 4c2.3 0 3.9 1 4.8 1.9l2.3-2.2C17.6 2.3 15.1 1 12 1 6.2 1 1.5 5.7 1.5 11.5S6.2 22 12 22c6 0 10-4.2 10-10.2 0-.7-.1-1.3-.2-1.8H12z" />
    </svg>
  );
}

/** Monochrome GitHub mark — official octocat silhouette, currentColor. */
function GitHubMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={cn("h-4 w-4 shrink-0 text-primary", className)}
      fill="currentColor"
    >
      <path d="M12 1.5C6.2 1.5 1.5 6.2 1.5 12c0 4.6 3 8.5 7.2 9.9.5.1.7-.2.7-.5v-1.9c-2.9.6-3.6-1.2-3.6-1.2-.5-1.2-1.2-1.6-1.2-1.6-1-.7.1-.7.1-.7 1.1.1 1.6 1.1 1.6 1.1 1 1.7 2.6 1.2 3.2.9.1-.7.4-1.2.7-1.5-2.4-.3-4.9-1.2-4.9-5.4 0-1.2.4-2.2 1.1-2.9-.1-.3-.5-1.4.1-2.9 0 0 .9-.3 3 1.1.8-.2 1.7-.3 2.6-.3s1.8.1 2.6.3c2.1-1.4 3-1.1 3-1.1.6 1.5.2 2.6.1 2.9.7.7 1.1 1.7 1.1 2.9 0 4.2-2.5 5.1-4.9 5.4.4.3.7.9.7 1.9v2.9c0 .3.2.6.7.5 4.2-1.4 7.2-5.3 7.2-9.9 0-5.8-4.7-10.5-10.5-10.5z" />
    </svg>
  );
}

export function OAuthButtons({ callbackURL }: { callbackURL?: string }) {
  const [pending, setPending] = useState<"google" | "github" | null>(null);

  async function signInWith(provider: "google" | "github") {
    setPending(provider);
    // Full-page redirect to the provider; no success handling needed here.
    await authClient.signIn.social({
      provider,
      callbackURL: callbackURL ?? "/w",
    });
  }

  return (
    <div className="flex flex-col gap-3" data-testid="oauth-buttons">
      <Button
        variant="secondary"
        size="lg"
        className="w-full"
        loading={pending === "google"}
        onClick={() => signInWith("google")}
      >
        <GoogleMark />
        Continue with Google
      </Button>
      <Button
        variant="secondary"
        size="lg"
        className="w-full"
        loading={pending === "github"}
        onClick={() => signInWith("github")}
      >
        <GitHubMark />
        Continue with GitHub
      </Button>
    </div>
  );
}
