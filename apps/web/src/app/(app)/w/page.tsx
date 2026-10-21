import { pageMetadata } from "@/lib/seo";
import { EmptyState } from "@studio/ui";

export const metadata = pageMetadata({
  title: "Workspace",
  description: "Your Studio workspace.",
  path: "/w",
});

/**
 * TEMPORARY stub (Wave 3 replaces this with the real dashboard, §8.4).
 * The route exists so /sign-up, the invite flow and the proxy have a
 * landing spot today.
 */
export default function WorkspaceStubPage() {
  return (
    <main id="main" className="flex min-h-svh items-center justify-center bg-app px-5">
      <EmptyState
        data-testid="workspace-stub"
        title="The workspace is loading."
        secondaryLink={{ label: "Back to the site", href: "/" }}
      />
    </main>
  );
}
