import { VerifyEmailPanel } from "@/components/auth/verify-email-panel";
import { pageMetadata } from "@/lib/seo";
import { Brand } from "@studio/config";
import { Suspense } from "react";

export const metadata = pageMetadata({
  title: "Verify your email",
  description: `Confirm your email address for ${Brand.productName}.`,
  path: "/verify-email",
});

/**
 * Verify-email route (M9-H): reads `?token=…` from a verification link and
 * verifies it client-side via better-auth, with honest verifying →
 * success/failure states (§14). Suspense is required because the panel reads
 * search params (same pattern as /sign-in).
 */
export default function VerifyEmailPage() {
  return (
    <Suspense fallback={null}>
      <VerifyEmailPanel />
    </Suspense>
  );
}
