// Sign-up stub (W1-K) — see src/components/auth-form.tsx for the client
// boundary; TODO(W4 auth wiring) replaces the stub with the Better Auth flow.

import type { Metadata } from "next";
import { AuthForm } from "@/components/auth-form";

export const metadata: Metadata = {
  title: "Create account",
};

export default function SignUpPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-surface-muted px-6">
      <AuthForm mode="sign-up" />
    </main>
  );
}
