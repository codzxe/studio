// Template gallery page (W8-J) — the in-app slice of the §16.2 "template
// gallery": filter chips + search over `GET /v1/templates` cards (§7.4),
// "Use template" → compose preselect (?template=id@version, W8-D contract),
// "Manifest" → the full §7.2 payload. Server component for metadata only —
// the interactive gallery is a client component (React Query owns the
// gateway state, src/app/providers.tsx).

import type { Metadata } from "next";
import { TemplateGallery } from "@/components/gallery/template-gallery";

export const metadata: Metadata = {
  title: "Templates",
  description:
    "Browse the template catalog and start from a real layered document with named slots.",
};

export default function TemplatesPage() {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
      <TemplateGallery />
    </main>
  );
}
