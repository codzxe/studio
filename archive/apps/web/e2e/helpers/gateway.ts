// W10-L — gateway reachability probe for the mock-mode contract.
//
// The §21 journey runs against MOCK MODE ONLY: the compose "local" profile
// (gateway wired to MockEngineAdapter → apps/mock-engine, and the NoopStripe
// seam → apps/gateway/src/services/stripe.ts). That profile is a documented
// REQUIREMENT of this suite (e2e/README.md §Contract) — while it is missing,
// every gateway-dependent spec must SKIP loudly, never fail (§21 "Definition
// of a good test": fails loudly with a message that says what to do).
import process from "node:process";

/** Gateway origin (compose §22 contract: bridge-only :3001, never public). */
export const GATEWAY_URL = process.env.E2E_GATEWAY_URL ?? "http://localhost:3001";

export interface GatewayProbe {
  reachable: boolean;
  detail: string;
}

export const GATEWAY_SKIP_REASON =
  `gateway not reachable at ${GATEWAY_URL} — start the compose "local" profile ` +
  "(gateway + MockEngineAdapter + NoopStripe), or set E2E_GATEWAY_URL; " +
  "see apps/web/e2e/README.md §Contract";

let cached: GatewayProbe | null = null;

/**
 * Any HTTP response (even 404/401) counts as reachable — the probe is
 * path-agnostic on purpose so it never guesses a gateway health route.
 * Connection refused / timeout = not reachable. Cached per worker (workers=1).
 */
export async function probeGateway(timeoutMs = 2000): Promise<GatewayProbe> {
  if (cached) return cached;
  try {
    const res = await fetch(GATEWAY_URL, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    cached = { reachable: true, detail: `probe: HTTP ${res.status}` };
  } catch (err) {
    cached = {
      reachable: false,
      detail: `probe: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }
  return cached;
}
