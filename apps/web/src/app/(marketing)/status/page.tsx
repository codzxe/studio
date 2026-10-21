// Status page — HONEST STUB (W8-M).
//
// §16.2 plumbing calls for a public status page (Uptime Kuma) linked from
// the footer. The monitoring instance is not deployed yet, so this stub
// says exactly that instead of faking an "all systems operational" badge.
// TODO(ops-wave): point the footer link at the live dashboard (or embed it
// here) once Uptime Kuma is running; the app already exposes /health for
// probes.

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Status",
  description: "Service status — live dashboard publishes here at launch.",
};

export default function StatusPage() {
  return (
    <section className="mx-auto w-full max-w-3xl px-6 py-14" data-testid="marketing-status">
      <h1 className="text-3xl font-semibold tracking-tight">Status</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        The public uptime dashboard publishes here when the service opens for
        beta. We are not displaying a live status badge before monitoring is
        actually running — no green checkmarks that do not mean anything yet.
      </p>
      <p className="mt-3 text-sm text-muted-foreground">
        The application exposes a machine-readable health endpoint at{" "}
        <code className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-xs">/health</code>{" "}
        for uptime probes.
      </p>
    </section>
  );
}
