import { SignUpForm } from "@/components/auth/sign-up-form";
import { pageMetadata } from "@/lib/seo";
import { Suspense } from "react";

export const metadata = pageMetadata({
  title: "Create your workspace",
  // Plan-agnostic on purpose (W4-KILL): no price is hardcoded in SEO/OG copy —
  // the catalog (packages/config PLAN_CATALOG) is BUSINESS-PENDING and every
  // priced surface derives from it (/pricing). This copy can never contradict it.
  description:
    "Create a Studio workspace — 14 days free with card, then pick a plan. Cancel anytime.",
  path: "/sign-up",
});

export default function SignUpPage() {
  return (
    <Suspense fallback={null}>
      <SignUpForm />
    </Suspense>
  );
}
