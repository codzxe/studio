// (auth) route-group layout (W8-B) — centered card chrome shared by the auth
// pages (/sign-in, /sign-up and any future auth screen). The (app) routes get
// their own shell; auth renders inside this minimal centered frame — no app
// chrome, no session reads, so every page below stays statically
// prerenderable (§16.2 option (a): marketing and product share one app).

import type { ReactNode } from "react";

// TODO(branding): "Layerly" is the temporary neutral working name (W1-K);
// replace with the real wordmark before launch. The forbidden names (§1.5)
// and the internal codename never appear in user-facing strings.
const SITE_NAME = "Layerly";

export default function AuthLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-surface-muted px-6 py-12">
      {/* TODO(branding): placeholder wordmark — swap with the real logo. */}
      <a
        href="/"
        className="font-mono text-lg font-semibold tracking-tight text-foreground"
      >
        {SITE_NAME}
      </a>
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-6 shadow-sm">
        {children}
      </div>
      <p className="text-center text-xs text-muted-foreground">
        Editable layers, not flat pixels.
      </p>
    </main>
  );
}
