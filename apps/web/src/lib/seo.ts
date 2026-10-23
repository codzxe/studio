import { Brand } from "@studio/config";
import type { Metadata } from "next";

/**
 * Per-page metadata helpers. All copy flows from Brand tokens
 * (packages/config/src/brand.ts) — nothing hardcodes the product name.
 */

/**
 * The placeholder origin used when `NEXT_PUBLIC_APP_URL` is unset. This is
 * Brand.domains.marketing — a BUSINESS-PENDING placeholder domain, NOT a real
 * deployment origin: canonical + OpenGraph URLs built from it are wrong.
 */
const FALLBACK_URL = `https://${Brand.domains.marketing}`;

/** True only for local development boots (`next dev`, APP_ENV=local). */
function isLocalDevelopment(): boolean {
  return process.env.APP_ENV === "local" || process.env.NODE_ENV === "development";
}

/**
 * Canonical origin: `NEXT_PUBLIC_APP_URL` (explicit in every real deploy).
 *
 * Fallback behavior when it is unset or blank:
 * - LOCAL DEVELOPMENT (`APP_ENV=local` or `NODE_ENV=development`): falls
 *   back to {@link FALLBACK_URL} silently — metadata URLs don't matter on a
 *   dev box and the env is intentionally optional there.
 * - ANY OTHER ENVIRONMENT (staging/production builds and boots): falls back
 *   to {@link FALLBACK_URL} but WARNS LOUDLY at module load. A silent
 *   fallback would ship the placeholder domain in every canonical/OpenGraph
 *   URL without anyone noticing, so the misconfiguration must be visible —
 *   but it must NOT throw: metadata is not worth taking a boot down for.
 *
 * Deploy fix: set `NEXT_PUBLIC_APP_URL` to the public origin (scheme +
 * host, e.g. `https://app.example.com`) in the deployment environment and
 * rebuild (NEXT_PUBLIC_* vars are baked at build time).
 */
function resolveSiteUrl(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured !== undefined && configured.length > 0) return configured;
  if (!isLocalDevelopment()) {
    // biome-ignore lint/suspicious/noConsole: the loud non-local fallback warning IS the product behavior here (deploy visibility), not debug logging
    console.warn(
      `[seo] NEXT_PUBLIC_APP_URL is not set — canonical and OpenGraph URLs fall back to the placeholder domain ${FALLBACK_URL}. Fix the deployment: set NEXT_PUBLIC_APP_URL to the public origin (e.g. https://app.example.com) and rebuild (NEXT_PUBLIC_* vars are baked at build time). Detected APP_ENV=${process.env.APP_ENV ?? "unset"}, NODE_ENV=${process.env.NODE_ENV ?? "unset"}, NEXT_PUBLIC_APP_URL=${configured === undefined ? "unset" : "blank"}.`,
    );
  }
  return FALLBACK_URL;
}

export const SITE_URL = resolveSiteUrl();

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
