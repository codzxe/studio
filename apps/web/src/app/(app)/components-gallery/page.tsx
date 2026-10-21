// Component library page (W8-J) — reusable, variable-driven pieces (§8):
// filter chips + search over `GET /v1/components` cards (§8.3), variable
// chips per card, "Manifest" → the full §8.2 payload, "Place in document" →
// the document picker stub (editor shell wave). Server component for
// metadata only; the interactive gallery is a client component.

import type { Metadata } from "next";
import { ComponentGallery } from "@/components/gallery/component-gallery";

export const metadata: Metadata = {
  title: "Component library",
  description: "Reusable, variable-driven components to place in any document.",
};

export default function ComponentsGalleryPage() {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
      <ComponentGallery />
    </main>
  );
}
