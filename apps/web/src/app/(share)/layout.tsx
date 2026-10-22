import type { Metadata } from "next";

/**
 * Share route group — the PUBLIC /s/:token review surface (BUILD_PLAN §M7
 * task 5). Entirely anonymous chrome: no workspace header, no marketing
 * footer, no auth surfaces. A share link is a review capability, not a page
 * to index — the group metadata is `noindex`/`nofollow` and the title stays
 * generic (the project name reaches the reviewer's eyes only).
 */
export const metadata: Metadata = {
  title: "Shared review",
  description: "A shared review link.",
  robots: {
    index: false,
    follow: false,
  },
};

export default function ShareLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col bg-app">
      {/* §12 — keyboard users land on content first. */}
      <main id="main" className="flex flex-1 flex-col">
        {children}
      </main>
    </div>
  );
}
