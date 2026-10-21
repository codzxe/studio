// app/(app) layout — the authenticated product shell (W8-A).
//
// Route-group note: "(app)" (and "(dashboard)" below) add no URL segment —
// this layout wraps every product route (marketing + auth stay outside it,
// §16.2 option (a): marketing routes inside this one Next app, ADR-0002).
//
// TODO(W8-B auth wiring): the session gate — redirect to /sign-in when
// Better Auth reports no session (per-request check or middleware). Until
// then the shell renders for everyone and gateway calls answer 401; the
// components surface those as typed error states (src/hooks/use-session.tsx).

import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { SessionProvider } from "@/hooks/use-session";

export default function AppGroupLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <SessionProvider>
      <AppShell>{children}</AppShell>
    </SessionProvider>
  );
}
