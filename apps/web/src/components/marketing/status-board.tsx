"use client";

import { Button, StatusDot } from "@studio/ui";
import { useCallback, useEffect, useState } from "react";

/**
 * StatusBoard — the live part of /status (M9-E, AUD-5). A client component
 * that fetches the REAL public health endpoint from the visitor's browser and
 * renders only what it can verify.
 *
 * HONESTY CONTRACT (§2.1 no invented metrics + §8.11):
 * - The check hits the same-origin `/v1/health` route — the gateway's public
 *   capability-flags endpoint (services/gateway/src/routes/health.ts; public:
 *   no auth, it answers `{ status: "ok", db, version }` even when the database
 *   is down — that's the §14 "degraded boot" contract). It is NOT a §7.3
 *   envelope, so this uses plain fetch, not the api-client.
 * - The browser convention is same-origin `/v1` (Caddy/the edge fronts it in
 *   production and the e2e edge in dev — apps/web/README.md §Env). If the
 *   check cannot complete, the board stays at "Checking…" with the reason:
 *   it never renders an unverified "operational".
 * - No uptime percentages, no incident history, no auto-refresh. The visitor
 *   re-checks with the button; "Last checked" is when an answer last arrived.
 */

/** The health route's JSON shape (capability flags, §14 degraded boot). */
interface HealthBody {
  readonly status: string;
  readonly db: boolean;
  readonly version: string;
}

/** One check's outcome; `null` = no verified answer yet. */
type CheckState =
  | { readonly phase: "checking" }
  | { readonly phase: "checked"; readonly health: HealthBody }
  | { readonly phase: "unreachable" };

/** §14-friendly clock stamp (24h HH:MM:SS, local time, tabular). */
function formatClock(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Narrow, hostile-proof guard for the health body. */
function isHealthBody(value: unknown): value is HealthBody {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).status === "string" &&
    typeof (value as Record<string, unknown>).db === "boolean" &&
    typeof (value as Record<string, unknown>).version === "string"
  );
}

export function StatusBoard() {
  const [state, setState] = useState<CheckState>({ phase: "checking" });
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [busy, setBusy] = useState(true);

  /**
   * One health check. The button is disabled while a check is in flight, so
   * there is never more than one outstanding attempt; the verified state
   * always belongs to the check that answered last.
   */
  const runCheck = useCallback(async () => {
    setBusy(true);
    setState({ phase: "checking" });
    try {
      const response = await fetch("/v1/health", { cache: "no-store" });
      if (!response.ok) throw new Error("health check failed");
      const body: unknown = await response.json();
      if (!isHealthBody(body)) throw new Error("unexpected health body");
      setState({ phase: "checked", health: body });
    } catch {
      setState({ phase: "unreachable" });
    } finally {
      setCheckedAt(new Date());
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void runCheck();
  }, [runCheck]);

  const gatewayUnverified = state.phase !== "checked";
  const dbDown = state.phase === "checked" && !state.health.db;

  return (
    <div
      data-testid="status-board"
      className="flex flex-col gap-6 rounded-md border border-border bg-panel p-6"
    >
      <div className="flex flex-col">
        <div className="flex items-center justify-between gap-6 border-b border-border py-4">
          <p className="text-body text-secondary">API gateway</p>
          {gatewayUnverified ? (
            <StatusDot tone="ice">Checking…</StatusDot>
          ) : (
            <StatusDot tone="success">
              Reachable
              <span className="tabular text-mono text-muted"> · v{state.health.version}</span>
            </StatusDot>
          )}
        </div>
        <div className="flex items-center justify-between gap-6 border-b border-border py-4">
          <p className="text-body text-secondary">Database</p>
          {gatewayUnverified ? (
            <StatusDot tone="ice">Checking…</StatusDot>
          ) : dbDown ? (
            <StatusDot tone="warning">Degraded — not answering</StatusDot>
          ) : (
            <StatusDot tone="success">Connected</StatusDot>
          )}
        </div>
      </div>

      {state.phase === "unreachable" ? (
        <p
          data-testid="status-unreachable-note"
          className="text-body-s leading-relaxed text-secondary"
        >
          The last check could not reach the health endpoint from your browser — that can be the
          service, your network, or the connection between them. This page only reports what it can
          verify, so it stays at “Checking…” until a check succeeds.
        </p>
      ) : null}
      {dbDown ? (
        <p className="text-body-s leading-relaxed text-secondary">
          The API answered, but its database did not. Sign-in, saving and renders may fail until it
          recovers — everything else on this page is the last verified state.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border pt-4">
        <p aria-live="polite" className="tabular text-mono text-caption text-muted">
          {busy
            ? "Checking…"
            : checkedAt === null
              ? "Not checked yet"
              : `Last checked ${formatClock(checkedAt)}`}
        </p>
        <Button
          variant="secondary"
          size="md"
          onClick={() => {
            void runCheck();
          }}
          disabled={busy}
        >
          Check again
        </Button>
      </div>
    </div>
  );
}
