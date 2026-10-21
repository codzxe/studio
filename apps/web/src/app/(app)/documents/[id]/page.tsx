// apps/web — document overview route (W8-C, §13.1 GET /v1/documents/:id).
//
// Renders the document overview: meta bar (name, revision, created) plus the
// EDITOR surface. The editor is delegated to <DocumentEditor> — a placeholder
// owned by W8-F. The import contract is frozen and documented in
// @/components/documents/document-editor.tsx: props { documentId, document }.
//
// Like the library page: a <section> landmark (not <main>) so the W8-A shell
// can own the page landmark; all data fetching is client-side through the
// typed gateway client (lib/api.ts) inside DocumentOverview.

import { DocumentOverview } from "@/components/documents/document-overview";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Document",
  // TODO(W8-F editor wave): generateMetadata could surface the real document
  // name via a server-side gateway call with the session cookie.
};

interface DocumentPageProps {
  /** Next 15: dynamic params resolve asynchronously. */
  readonly params: Promise<{ readonly id: string }>;
}

export default async function DocumentPage({ params }: DocumentPageProps) {
  const { id } = await params;
  return (
    <section
      aria-labelledby="document-heading"
      className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8"
    >
      <DocumentOverview documentId={id} />
    </section>
  );
}
