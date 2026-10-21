import { EmptyState, buttonVariants } from "@studio/ui";
import Link from "next/link";

/**
 * 404 (§8.11): "This frame doesn't exist." + back to projects. Kept short.
 */
export default function NotFound() {
  return (
    <main id="main" className="flex min-h-svh items-center justify-center bg-app px-5">
      <EmptyState
        data-testid="not-found"
        title="This frame doesn't exist."
        action={
          <Link href="/w" className={buttonVariants({ variant: "primary", size: "md" })}>
            Back to projects
          </Link>
        }
        secondaryLink={{ label: "Back to the site", href: "/" }}
      />
    </main>
  );
}
