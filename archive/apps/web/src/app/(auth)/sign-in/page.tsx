// Sign-in page (W8-B) — replaces the W1-K stub with the real Better Auth flow.
// Server wrapper keeps metadata server-side and Suspense-bounds the form: the
// form reads `?next=` via useSearchParams, which needs a boundary for Next's
// static prerender. Card chrome comes from the (auth) layout.

import type { Metadata } from "next";
import { Suspense } from "react";
import { SignInForm } from "../components/sign-in-form";
import { AuthFormFallback } from "../components/form-fallback";

export const metadata: Metadata = {
  title: "Sign in",
};

export default function SignInPage() {
  return (
    <Suspense fallback={<AuthFormFallback />}>
      <SignInForm />
    </Suspense>
  );
}
