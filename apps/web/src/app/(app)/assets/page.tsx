// app/(app)/assets — placeholder (W8-A). TODO(assets wave): the asset
// library — uploads via POST /v1/uploads + GET /v1/assets (§13.1), MIME
// sniffing and EXIF-strip notes surfaced per §15.2.

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Assets",
};

export default function AssetsPage() {
  return (
    <section aria-labelledby="assets-heading" className="max-w-3xl">
      <h1 id="assets-heading" className="text-2xl font-semibold tracking-tight">
        Assets
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Your uploaded images and brand files will live here — this placeholder keeps the shell
        navigable.
      </p>
    </section>
  );
}
