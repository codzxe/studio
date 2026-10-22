/**
 * Billing-page display helpers (BUILD_PLAN §M6 task 4; UI_DESIGN_SYSTEM §8.8
 * + §14; DECISIONS D-12).
 *
 * Pure, deterministic (UTC dates, fixed `now` parameters — never Date.now()
 * inside), and token-free by construction (no markup here). The D-12 µc →
 * credits conversion DELEGATES to the billing kit's shared display math
 * (`ledger-table.tsx` — the same helpers the ledger/top-up/low-credit
 * surfaces use, so the whole page formats identically); byte formatting
 * delegates to `usage-meters.tsx` (`formatStorageBytes`, §14 style).
 */

import { formatCreditsDisplay, microcreditsToCreditsDisplay } from "./ledger-table";
import { formatStorageBytes } from "./usage-meters";

/** §14: numbers use `en-US` commas; credits carry exactly 2 decimals (kit). */
export function formatCredits(microcredits: number): string {
  const credits = microcreditsToCreditsDisplay(microcredits);
  return credits === null ? "—" : formatCreditsDisplay(credits);
}

/** §14: dates render as `Oct 21, 2026` — UTC so renders are deterministic. */
const dateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** §14: whole counts with commas (seats, render minutes, pack credits). */
export function formatCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0";
  return Math.floor(value).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

const CENTS_PER_DOLLAR = 100;

/** Integer cents → `$12/mo` (§14; the display catalog carries monthly cents). */
export function formatMonthlyPrice(cents: number): string {
  if (!Number.isFinite(cents) || cents < 0) return "$0/mo";
  const dollars = Math.floor(cents) / CENTS_PER_DOLLAR;
  return `$${dollars.toLocaleString("en-US", { maximumFractionDigits: 2 })}/mo`;
}

/** ISO-8601 → `Oct 21, 2026` (§14). Empty/invalid input renders as `—`. */
export function formatDate(iso: string | null | undefined): string {
  if (typeof iso !== "string" || iso === "") return "—";
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "—";
  return dateFormatter.format(new Date(time));
}

const DAY_MS = 86_400_000;

/**
 * Whole days remaining until an ISO-8601 instant, floored and clamped to
 * `0` (the in-progress day still counts). Pure: `now` is always a parameter
 * so callers (and tests) pin the clock.
 */
export function daysUntil(iso: string | null | undefined, now: Date): number {
  if (typeof iso !== "string" || iso === "") return 0;
  const end = Date.parse(iso);
  if (Number.isNaN(end)) return 0;
  return Math.max(0, Math.floor((end - now.getTime()) / DAY_MS));
}

/** Storage quota display (§14 byte style via the kit's helper). */
export function formatStorage(bytes: number): string {
  return formatStorageBytes(bytes);
}
