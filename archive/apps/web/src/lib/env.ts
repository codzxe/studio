// apps/web — browser-bundle env contract (W1-K).
//
// Only `NEXT_PUBLIC_`-prefixed vars are inlined into the browser bundle
// (next.config.ts pins `envPrefix: "NEXT_PUBLIC_"`); this module is their
// one typed home — app code never reads `process.env` directly
// (docs/AGENTS.md "Zod at every boundary" + `.env.example` header rules).
//
// Server-only web env (PORT, Stripe publishable key, DB URL…) is owned by
// `@studio/config`'s `parseWebEnv` (§4); this is the *client-side* projection
// of that contract and stays deliberately tiny.
//
// Parsing is LAZY (first call), not at module scope: `next build` prerenders
// client components without a `.env`, so a module-scope throw would break CI
// builds. The first real use (form submit, first gateway call) fails fast
// with a message naming the missing variable (§4 "missing var = refuse").

import { z } from "zod";

/** Minimal env source (subset of NodeJS.ProcessEnv; keeps tests hermetic). */
export type EnvSource = Record<string, string | undefined>;

const httpUrl = z
  .string()
  .refine((value) => /^https?:\/\//.test(value), "must be an http(s) URL");

const clientEnvSchema = z.object({
  // Gateway REST + SSE base INCLUDING the `/v1` prefix — canonical value in
  // .env.example: NEXT_PUBLIC_API_BASE_URL=http://localhost:8787/v1 (§13).
  NEXT_PUBLIC_API_BASE_URL: httpUrl,
  // Optional on the client: the browser rarely needs its own origin
  // (metadataBase / sitemap are server-side). Parsed when present so typos
  // still fail fast.
  NEXT_PUBLIC_APP_URL: httpUrl.optional(),
});

/** Typed, validated client env. `apiBaseUrl` never has a trailing slash. */
export interface WebClientEnv {
  readonly apiBaseUrl: string;
  readonly appUrl: string | undefined;
}

/** Fail-fast env error listing the offending variable names (§4). */
export class ClientEnvError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `apps/web: invalid browser environment — ${problems.join("; ")}. ` +
        "Copy .env.example to .env (see the Web section) and restart the dev server.",
    );
    this.name = "ClientEnvError";
    this.problems = problems;
  }
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Pure parser: source in, typed env out, throws ClientEnvError on bad input. */
export function parseWebClientEnv(source: EnvSource): WebClientEnv {
  const parsed = clientEnvSchema.safeParse({
    NEXT_PUBLIC_API_BASE_URL: source.NEXT_PUBLIC_API_BASE_URL,
    NEXT_PUBLIC_APP_URL: source.NEXT_PUBLIC_APP_URL,
  });
  if (parsed.success) {
    return {
      apiBaseUrl: trimTrailingSlash(parsed.data.NEXT_PUBLIC_API_BASE_URL),
      appUrl:
        parsed.data.NEXT_PUBLIC_APP_URL === undefined
          ? undefined
          : trimTrailingSlash(parsed.data.NEXT_PUBLIC_APP_URL),
    };
  }
  const problems = parsed.error.issues.map(
    (issue) => `${String(issue.path[0] ?? "?")}: ${issue.message}`,
  );
  throw new ClientEnvError(problems);
}

let cachedProcessEnv: WebClientEnv | undefined;

/**
 * Reads and validates the NEXT_PUBLIC_ contract. Memoized for the default
 * `process.env` source (the inlined bundle vars never change at runtime);
 * an explicit source is parsed fresh so tests stay deterministic.
 */
export function getClientEnv(source: EnvSource = process.env): WebClientEnv {
  if (source === process.env && cachedProcessEnv !== undefined) {
    return cachedProcessEnv;
  }
  const env = parseWebClientEnv(source);
  if (source === process.env) {
    cachedProcessEnv = env;
  }
  return env;
}
