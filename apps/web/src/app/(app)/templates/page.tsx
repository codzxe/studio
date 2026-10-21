// app/(app)/templates — placeholder (W8-A). TODO(catalog wave): the template
// catalog from GET /v1/templates (§13.1), manifests + live previews, and the
// create-from-template flow (POST /v1/documents with the §13.1 `template`
// key — useCreateDocument already accepts templateId).

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Templates",
};

export default function TemplatesPage() {
  return (
    <section aria-labelledby="templates-heading" className="max-w-3xl">
      <h1 id="templates-heading" className="text-2xl font-semibold tracking-tight">
        Templates
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        The template catalog is on its way — this placeholder keeps the shell navigable.
      </p>
    </section>
  );
}
