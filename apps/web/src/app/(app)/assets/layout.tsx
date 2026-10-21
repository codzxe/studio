// Route frame for the asset library (W8-I). The (app) shell layout lands
// with its own wave; this nested layout only supplies the page title
// (root template: "%s — Layerly") and the content column.

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Assets",
};

export default function AssetsLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      {children}
    </main>
  );
}
