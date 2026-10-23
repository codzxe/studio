import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { pageMetadata } from "@/lib/seo";
import { Brand } from "@studio/config";
import { Suspense } from "react";

export const metadata = pageMetadata({
  title: "Pick a new password",
  description: `Set a new password for your ${Brand.productName} account from your reset email.`,
  path: "/reset-password",
});

/**
 * Reset-password route (M9-H): the destination of the reset email's
 * `${origin}/reset-password` link — better-auth's token callback redirects
 * here with `?token=…` (or `?error=INVALID_TOKEN`). Suspense is required
 * because the form reads search params (same pattern as /sign-in).
 */
export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  );
}
