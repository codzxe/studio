// app/(app)/documents — placeholder (W8-A). TODO(documents wave): the real
// documents library — grid, filters, create-from-template — wired to
// GET /v1/documents (§13.1) via the placeholder hooks in
// src/hooks/use-session.tsx (useRecentDocuments is the seed).

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Documents",
};

export default function DocumentsPage() {
  return (
    <section aria-labelledby="documents-heading" className="max-w-3xl">
      <h1 id="documents-heading" className="text-2xl font-semibold tracking-tight">
        Documents
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        The documents library is on its way — this placeholder keeps the shell navigable.
      </p>
    </section>
  );
}
