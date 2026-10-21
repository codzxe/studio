// Sign-up page (W8-B) — replaces the W1-K stub with the real Better Auth
// flow. Server wrapper keeps metadata server-side and Suspense-bounds the
// form (it reads `?next=` via useSearchParams for the invite round-trip).
// Card chrome comes from the (auth) layout.

import type { Metadata } from "next";
import { Suspense } from "react";
import { SignUpForm } from "../components/sign-up-form";
import { AuthFormFallback } from "../components/form-fallback";

export const metadata: Metadata = {
  title: "Create account",
};

export default function SignUpPage() {
  return (
    <Suspense fallback={<AuthFormFallback />}>
      <SignUpForm />
    </Suspense>
  );
}
