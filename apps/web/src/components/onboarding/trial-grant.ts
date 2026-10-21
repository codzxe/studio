// components/onboarding/trial-grant.ts — step 0 of the first-success
// checklist (§19 Phase 4): verify the trial credit grant with a GET
// /v1/credits check (API table §13). Pure parsing + a thin injectable fetch
// default, so hosts can swap in their own session-aware client.

export const CREDITS_PATH = "/v1/credits"; // §13 API table: "GET /v1/credits — Balance + ledger page"

export interface TrialGrantOk {
  readonly ok: true;
  readonly balance: number;
}

export interface TrialGrantFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly hint: string;
  readonly retryable: boolean;
}

export type TrialGrantResult = TrialGrantOk | TrialGrantFailure;

/** Injected seam: hosts with a session-aware gateway client pass their own. */
export type TrialGrantCheck = () => Promise<TrialGrantResult>;

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Best-effort balance extraction across plausible response shapes
 * (`{balance}`, `{credits}`, `{data:{…}}`, `{credits:{balance}}`).
 * Returns null when no number is found — the caller treats that as
 * "couldn't read", never as zero.
 */
export function extractBalance(payload: unknown): number | null {
  if (typeof payload !== "object" || payload === null) return null;
  const root = payload as Record<string, unknown>;
  const data =
    typeof root.data === "object" && root.data !== null
      ? (root.data as Record<string, unknown>)
      : null;
  const nested =
    typeof root.credits === "object" && root.credits !== null
      ? (root.credits as Record<string, unknown>)
      : null;
  const candidates: unknown[] = [
    root.balance,
    root.credits,
    data?.balance,
    data?.credits,
    nested?.balance,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Default step-0 check. Errors are typed envelopes (never throws, never leaks
 * internals). A missing/unimplemented route surfaces as a retryable failure —
 * the checklist shows a subtle "couldn't verify" with a Retry, and a host can
 * override via props once /v1/credits lands.
 */
export async function defaultCheckTrialGrant(
  fetchImpl: FetchLike = fetch,
): Promise<TrialGrantResult> {
  try {
    const response = await fetchImpl(CREDITS_PATH, {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "same-origin",
    });
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        code: "credits.unauthorized",
        message: "Couldn't verify your trial credits.",
        hint: "Sign in again, then the checklist picks this up.",
        retryable: false,
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        code: "credits.unavailable",
        message: "Couldn't verify your trial credits.",
        hint: "It'll retry automatically — no action needed.",
        retryable: true,
      };
    }
    const body: unknown = await response.json().catch(() => null);
    const balance = extractBalance(body);
    if (balance === null) {
      return {
        ok: false,
        code: "credits.unreadable",
        message: "Couldn't read your credit balance.",
        hint: "It'll retry automatically — no action needed.",
        retryable: true,
      };
    }
    return { ok: true, balance };
  } catch {
    return {
      ok: false,
      code: "credits.unreachable",
      message: "Couldn't reach the server to check your credits.",
      hint: "Check your connection, then retry.",
      retryable: true,
    };
  }
}
