// Share-page pure helpers (BUILD_PLAN §M7 task 5): time-unit conversion,
// display formatting and the guest-identity sessionStorage seam (D-10).
//
// Deliberately self-contained: NO import from `@/lib/chat/preview` — that
// module (the only other place this ticks constant lives in the app) pulls
// `@studio/editor-bridge` transitively, and the share page must NEVER drag
// any editor seam into an anonymous bundle (the share page is a PLAYER, not
// the editor). The constant is mirrored, like preview.ts itself mirrors it
// from `editor/crates/time/src/lib.rs`.

/**
 * Engine ticks per second (`n_PER_SECOND`, editor/crates/time/src/lib.rs) —
 * the unit every comment `timeTicks` anchor and asset `durationTicks` speak.
 */
export const TICKS_PER_SECOND = 254_016_000_000;

/** Player seconds → engine ticks (the comment-anchor unit), rounded. */
export function ticksFromSeconds(seconds: number): number {
  return Math.round(seconds * TICKS_PER_SECOND);
}

/** Engine ticks → seconds (one decimal is plenty for a review timecode). */
export function secondsFromTicks(ticks: number): number {
  return ticks / TICKS_PER_SECOND;
}

/** Compact review timecode: `0.0s`, `12.3s`, `96.0s` (never negative). */
export function formatSeconds(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  return `${safe.toFixed(1)}s`;
}

// ---------------------------------------------------------------------------
// Guest identity (sessionStorage ONLY — convenience, never auth)
// ---------------------------------------------------------------------------

/**
 * D-10 literal storage key. sessionStorage (not localStorage): a reviewer's
 * name/email live for THIS TAB's review session; it is convenience
 * pre-fill, never a credential and never a password.
 */
export const GUEST_IDENTITY_STORAGE_KEY = "studio.share.guest.v1";

export interface GuestIdentity {
  readonly name: string;
  readonly email: string;
}

const EMPTY_IDENTITY: GuestIdentity = { name: "", email: "" };

/**
 * Read the saved guest identity. Corrupt/missing JSON reads as empty —
 * a broken convenience value must never break the review page.
 */
export function loadGuestIdentity(storage: Pick<Storage, "getItem">): GuestIdentity {
  try {
    const raw = storage.getItem(GUEST_IDENTITY_STORAGE_KEY);
    if (raw === null) return EMPTY_IDENTITY;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return EMPTY_IDENTITY;
    const record = parsed as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "";
    const email = typeof record.email === "string" ? record.email : "";
    return { name, email };
  } catch {
    return EMPTY_IDENTITY;
  }
}

/** Persist the guest identity (write failures are swallowed — convenience). */
export function saveGuestIdentity(
  storage: Pick<Storage, "setItem">,
  identity: GuestIdentity,
): void {
  try {
    storage.setItem(GUEST_IDENTITY_STORAGE_KEY, JSON.stringify(identity));
  } catch {
    // Private-browsing/quota states: pre-fill just won't persist next time.
  }
}

/**
 * Light email shape check for inline UX feedback (mirrors the contracts
 * `GUEST_EMAIL_SCHEMA` intent: local@domain.tld, no whitespace). The real
 * bound is the schema — api-client validates every body client-side and the
 * gateway re-validates; this just fails fast with a friendly field error.
 */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
