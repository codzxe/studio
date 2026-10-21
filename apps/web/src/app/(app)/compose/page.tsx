// Compose page (W8-D) — the prompt composer entry, spec §3.3 step 1:
// prompt + optional template + attachments + tier → POST /v1/runs → the run
// timeline (W8-E, /runs/:id).
//
// Thin server component per the sign-in precedent (src/app/(auth)): the
// client boundary and all interaction state live in
// src/components/compose/prompt-composer.tsx, so this file never touches the
// gateway (§3.1 — the browser talks to the gateway, the server renders).
// TODO(W4 auth wiring): protected app routes land with the Better Auth
// middleware; until then the gateway's 401 envelopes render in the UI.

import type { Metadata } from "next";
import { PromptComposer } from "@/components/compose/prompt-composer";

export const metadata: Metadata = {
  title: "Compose",
};

export default function ComposePage() {
  return <PromptComposer />;
}
