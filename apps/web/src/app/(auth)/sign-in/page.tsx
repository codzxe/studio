import { SignInForm } from "@/components/auth/sign-in-form";
import { pageMetadata } from "@/lib/seo";
import { Brand } from "@studio/config";
import { Suspense } from "react";

export const metadata = pageMetadata({
  title: "Sign in",
  description: `Sign in to ${Brand.productName}.`,
  path: "/sign-in",
});

export default function SignInPage() {
  return (
    <Suspense fallback={null}>
      <SignInForm />
    </Suspense>
  );
}
