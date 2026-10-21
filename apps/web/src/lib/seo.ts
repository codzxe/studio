import { Brand } from "@studio/config";
import type { Metadata } from "next";

/**
 * Per-page metadata helpers. All copy flows from Brand tokens
 * (packages/config/src/brand.ts) — nothing hardcodes the product name.
 */

/** Canonical origin: same-origin by default (local/dev), explicit in prod. */
export const SITE_URL =
  process.env.NEXT_PUBLIC_APP_URL && process.env.NEXT_PUBLIC_APP_URL.length > 0
    ? process.env.NEXT_PUBLIC_APP_URL
    : `https://${Brand.domains.marketing}`;

export function absoluteUrl(path = "/"): string {
  return new URL(path, SITE_URL).toString();
}

export function pageMetadata({
  title,
  description,
  path = "/",
}: {
  /** Page title — plugged into the root `%s` title template. */
  title: string;
  description: string;
  path?: string;
}): Metadata {
  const url = absoluteUrl(path);
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title: `${title} — ${Brand.productName}`,
      description,
      url,
      siteName: Brand.productName,
      type: "website",
    },
  };
}
