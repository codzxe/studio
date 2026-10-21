"use client";

import { Button, EmptyState } from "@studio/ui";

/**
 * Error boundary (§8.11): "Something broke on our side." + request id slot +
 * retry. The request id is error.digest when Next provides one (§14: errors
 * include a request id for support).
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main id="main" className="flex min-h-svh items-center justify-center bg-app px-5">
      <div className="flex flex-col items-center gap-4" data-testid="route-error">
        <EmptyState
          title="Something broke on our side."
          withIllustration
          action={
            <Button variant="primary" size="md" onClick={reset}>
              Try again
            </Button>
          }
          secondaryLink={{ label: "Back to the site", href: "/" }}
        />
        {error.digest ? (
          <p className="text-caption text-muted">
            Request id: <span className="font-mono text-secondary tabular">{error.digest}</span>
          </p>
        ) : null}
      </div>
    </main>
  );
}
