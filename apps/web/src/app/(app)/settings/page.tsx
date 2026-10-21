// app/(app)/settings — placeholder (W8-A). TODO(settings wave / W8-B):
// workspace members, roles and invites (POST /v1/workspaces/:id/invites,
// §13.1) and scoped API keys (§15.2) — all server-side RBAC enforced.

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Settings",
};

export default function SettingsPage() {
  return (
    <section aria-labelledby="settings-heading" className="max-w-3xl">
      <h1 id="settings-heading" className="text-2xl font-semibold tracking-tight">
        Settings
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Workspace members, invites and API keys will live here — this placeholder keeps the shell
        navigable.
      </p>
    </section>
  );
}
