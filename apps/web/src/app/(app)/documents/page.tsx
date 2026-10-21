// apps/web — documents library route (W8-C, §13.1 GET /v1/documents).
//
// Server page under the (app) route group (shell/layout owner: W8-A, see
// documents-library.tsx "Layout contract"). This page reads the `?q=` server
// query param and seeds the client library with it; filtering itself stays
// client-side until the gateway list endpoint grows a server-side `q`
// (its schema is strict over {cursor, limit, include_archived} today,
// apps/gateway/src/routes/documents.ts).
//
// No <main> here on purpose: when the (app) shell lands with its own
// <main> landmark, a nested one would be an a11y violation — the section
// landmark + labelled heading work standalone and inside the shell.

import { DocumentsLibrary } from "@/components/documents/documents-library";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Documents",
};

interface DocumentsPageProps {
  /** Next 15: search params resolve asynchronously (§ App Router). */
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function DocumentsPage({ searchParams }: DocumentsPageProps) {
  const params = await searchParams;
  const raw = params.q;
  const initialQuery = typeof raw === "string" ? raw : Array.isArray(raw) ? (raw[0] ?? "") : "";

  return (
    <section
      aria-labelledby="documents-heading"
      className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8"
    >
      <DocumentsLibrary initialQuery={initialQuery} />
    </section>
  );
}
