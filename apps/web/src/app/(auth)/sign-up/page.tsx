import { SignUpForm } from "@/components/auth/sign-up-form";
import { pageMetadata } from "@/lib/seo";
import { Suspense } from "react";

export const metadata = pageMetadata({
  title: "Create your workspace",
  description: "Create a Studio workspace — 14 days free with card, then $29/mo. Cancel anytime.",
  path: "/sign-up",
});

export default function SignUpPage() {
  return (
    <Suspense fallback={null}>
      <SignUpForm />
    </Suspense>
  );
}
