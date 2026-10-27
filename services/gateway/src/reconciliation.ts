// @studio/gateway — the M6 reconciliation job (BUILD_PLAN §M6 task 3
// "Reconciliation job with LiteLLM spend and render usage"; PRODUCT_ARCHITECTURE
// §8.8; D-12/D-19/D-20). REPORT-ONLY by default; ledger true-ups are behind an
// explicit `mode: "reconcile"` and are idempotent per (workspace, windowStart).
//
// WHAT IT COMPARES (three sides, all windowed to [sinceTs, uptoTs)):
//   (a) ledger   — append-only credit_ledger sums by kind, walked newest-first
//                  through repos.ledger.list (tenant-scoped, §8.8; D-20:
//                  reserve −N · commit −M · refund +N ⇒ a settled run nets
//                  exactly −M; amount/balance_after are bigint mode:"number",
//                  M6-E — exact ≤ 2^53). LEDGER ROWS ARE INTEGER µc (D-12).
//   (b) usage    — agent_runs.committedCredits for runs that committed in the
//                  window (the runs-table view of the same settles) plus
//                  renders.credits for renders created in the window. D-12
//                  row ruling: the run ROW speaks WHOLE CREDITS (the turn
//                  world's writers — routes/turn.ts heartbeats — never µc),
//                  so the core converts rows × MICROCREDITS_PER_CREDIT before
//                  folding them against the µc ledger sums (W3-b02 fix: the
//                  pre-fix raw mix made every turn-world workspace report a
//                  spurious ledger_usage_mismatch and a reconcile-mode
//                  true-up handed the whole commit back as balance).
//   (c) external — OPTIONAL LiteLLM spend (per-model token totals → credits
//                  via MODEL_CATALOG, the same rates the runner bills with).
//                  When no spend credential is configured the job DEGRADES to
//                  local-ledger-only reconciliation (this box's reality:
//                  LiteLLM is not deployed locally and the spend API is
//                  master-key protected — docs/deploy/LITELLM.md §3/§7).
//                  The comparison converts the credit-denominated spend to µc
//                  before comparing against the ledger commit sum (same
//                  W3-b02 unit normalization).
//
// DISCREPANCY TAXONOMY (typed; report carries facts, never secrets):
//   ledger_usage_mismatch   ledgerCommitSum ≠ usageSum (runs+renders). The
//                           run-row detail lists runs whose committedCredits
//                           disagree with their own ledger commits (two-sided
//                           drift: review WHICH side is wrong before
//                           true-upping — the flag is the review).
//   zombie_reserve          a run whose outstanding hold is > 0 and whose
//                           newest reserve entry is older than the grace
//                           window (D-19: disconnects cancel+refund; anything
//                           still holding after grace died without settling).
//   external_spend_mismatch LiteLLM-derived spend ≠ ledger commits. Window
//                           attribution noise is inherent (LiteLLM records at
//                           request time, the ledger at settle time; per-run
//                           ceil/min-1 rounding, M4-A, ≠ per-model exact
//                           math) — report-only, never auto-true-up.
//   negative_balance        balance < 0 — D-12: must NEVER happen. Critical.
//
//   NOT IMPLEMENTED, deliberately: a "balance_chain_broken" audit (Σ(amount)
//   ≠ newest balance_after) cannot be made sound on top of the current repo
//   surface — ledger.settle appends commit and refund in ONE transaction, so
//   they share created_at, and ledger.list orders by (created_at DESC, id
//   DESC) with random ids: "newest entry" is a coin flip between the two, and
//   the check false-positives on ~every settled run (proven live during M6-I;
//   the settle arithmetic itself is pinned by the @studio/db suite). A sound
//   chain audit needs a db-side ordered aggregate (insertion sequence or a
//   window SUM) — flagged for the db owner, not worked around here.
//
// TRUE-UP SEMANTICS (mode:"reconcile", never the default):
//   delta    = usageSum − ledgerCommitSum  (what the usage tables say beyond
//                                           what the ledger charged)
//   adjust   = −delta                      (kind="adjust", signed)
//   The ledger is the money record; the true-up makes its CHARGED total agree
//   with recorded usage. It never passes allowNegativeBalance (D-12 — a
//   true-up that would go below zero is refused by the ledger and surfaced as
//   a skipped action). Idempotency key = (workspace, windowStart), so replaying
//   the SAME window is free, but re-true-upping an OVERLAPPING SHIFTED window
//   double-adjusts the overlap — operators review the report-only run first.
//   Zombies are NEVER auto-released: a stuck hold may belong to a run that can
//   still settle; the remedy is the run-cancel/refund path, not a blind adjust.
//
// OPERATOR SWEEP RECIPE (v1 ships no scheduler; the cron is ops-owned):
//   1. Workspace ids (no repo enumeration method exists yet — law #12; the
//      sweep takes the list, the worker derives it):
//        psql "$DATABASE_URL" -Atc 'select id from organization'
//   2. Report-only sweep (recommended cadence: hourly, 24h window):
//        DATABASE_URL=… node --input-type=module -e '
//          const { createDb, createRepos } = await import("@studio/db");
//          const { runReconciliationSweep } = await import(
//            "./services/gateway/src/reconciliation.js");
//          const repos = createRepos(createDb(process.env.DATABASE_URL));
//          const upto = new Date();
//          const summary = await runReconciliationSweep({
//            repos,
//            workspaceIds,            // step 1
//            window: { sinceTs: new Date(upto - 86_400_000), uptoTs: upto },
//          });
//          if (summary.workspacesWithDiscrepancies > 0) process.exitCode = 2;
//        '
//   3. External spend (optional): export LITELLM_SPEND_KEY in the WORKER env —
//      the proxy MASTER key, ops-only (docs/deploy/LITELLM.md §3: "never in
//      the app env"). The 34-var app contract deliberately has no spend var
//      (same law-#12 pattern as billing.ts's STRIPE_BLOCKED_TRIAL_DOMAINS);
//      unset ⇒ createSpendSource returns null ⇒ local-ledger-only report.
//   4. After reviewing a discrepancy, true-up THAT window once:
//        … runReconciliationSweep({ repos, workspaceIds, window, mode:
//      "reconcile" }) — replay-safe per (workspace, windowStart).

import { createHash } from "node:crypto";

import { type StudioEnv, StudioError } from "@studio/config";
import { ISO8601_SCHEMA, MODEL_CATALOG, type ModelId } from "@studio/contracts";
import {
  type LedgerEntry as DbLedgerEntry,
  type Render,
  type Repos,
  deriveIdempotencyKey,
  isDbError,
  outstandingReserve,
} from "@studio/db";
import { z } from "zod";

import { MICROCREDITS_PER_CREDIT } from "./credits-display.js";
import type { Logger } from "./logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Window + options
// ─────────────────────────────────────────────────────────────────────────────

/** Half-open [sinceTs, uptoTs) reconciliation window. */
export interface ReconcileWindow {
  readonly sinceTs: Date;
  readonly uptoTs: Date;
}

export type ReconcileMode = "report" | "reconcile";

export interface ReconcileOptions {
  /** "report" (default): never writes. "reconcile": append the true-up adjust. */
  readonly mode?: ReconcileMode;
  /** A hold older than this with no settle is a zombie (default 30 min). */
  readonly zombieGraceMs?: number;
  /** Scan ceiling per ledger walk (default 5000 entries; truncation is flagged). */
  readonly scanLimit?: number;
  /** Operator note stamped into the adjust entry metadata (≤ 280 chars). */
  readonly note?: string;
  /** Clock seam (tests); zombie ages are measured against `now()`. */
  readonly now?: () => Date;
}

export const DEFAULT_ZOMBIE_GRACE_MS = 30 * 60_000;
export const DEFAULT_SCAN_LIMIT = 5000;

/** Longest window the route accepts (92 days ≈ a quarter of backfills). */
export const MAX_RECONCILE_WINDOW_MS = 92 * 86_400_000;

/** Allowed clock skew for an uptoTs in the "future" (route-level validation). */
const RECONCILE_CLOCK_SKEW_MS = 5_000;

const MIN_WINDOW_MS = 1;

/**
 * Pure window validation → a human-safe problem string (null = fine). Shared
 * by the route (400 VALIDATION_FAILED) and the sweep; the core re-guards
 * defensively with the same rule.
 */
export function reconcileWindowProblem(window: ReconcileWindow, now: Date): string | null {
  const { sinceTs, uptoTs } = window;
  if (!(sinceTs instanceof Date) || !(uptoTs instanceof Date)) {
    return "Window bounds must be valid timestamps.";
  }
  if (Number.isNaN(sinceTs.getTime()) || Number.isNaN(uptoTs.getTime())) {
    return "Window bounds must be valid timestamps.";
  }
  if (uptoTs.getTime() - sinceTs.getTime() < MIN_WINDOW_MS) {
    return "sinceTs must be strictly before uptoTs.";
  }
  if (uptoTs.getTime() - sinceTs.getTime() > MAX_RECONCILE_WINDOW_MS) {
    return "The reconciliation window must be at most 92 days.";
  }
  if (uptoTs.getTime() > now.getTime() + RECONCILE_CLOCK_SKEW_MS) {
    return "uptoTs must not be in the future.";
  }
  return null;
}

function guardWindow(window: ReconcileWindow, now: Date): void {
  const problem = reconcileWindowProblem(window, now);
  if (problem !== null) throw new StudioError("VALIDATION_FAILED", { message: problem });
}

// ─────────────────────────────────────────────────────────────────────────────
// Discrepancies (typed taxonomy)
// ─────────────────────────────────────────────────────────────────────────────

export type DiscrepancyCode =
  | "ledger_usage_mismatch"
  | "zombie_reserve"
  | "external_spend_mismatch"
  | "negative_balance";

/** One run whose committedCredits row disagrees with its own ledger commits. */
export interface RunRowDrift {
  readonly runId: string;
  /** Σ |commit| over the run's ledger entries — integer µc (D-12). */
  readonly ledgerCommits: number;
  /** The run row's committedCredits converted to µc (row is whole credits). */
  readonly rowCommitted: number;
}

export interface LedgerUsageMismatch {
  readonly code: "ledger_usage_mismatch";
  /** Σ |commit| over in-window ledger entries (integer µc, D-12). */
  readonly ledgerCommitSum: number;
  /** runs-table committed usage + renders-table credits for the window (µc). */
  readonly usageSum: number;
  /** usageSum − ledgerCommitSum in µc (positive: usage beyond what the ledger charged). */
  readonly delta: number;
  readonly runsUsage: number;
  readonly rendersUsage: number;
  readonly runCount: number;
  readonly renderCount: number;
  readonly runDrift: readonly RunRowDrift[];
}

export interface ZombieReserve {
  readonly code: "zombie_reserve";
  readonly runId: string;
  readonly outstanding: number;
  /** ISO timestamp of the run's newest reserve entry. */
  readonly reservedAt: string;
  readonly ageMs: number;
  /** agent_runs.status, or "missing" when the run row is gone (§9.3 cascade). */
  readonly runStatus: string;
}

export interface ModelSpendRow {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Catalog math over the model's token totals; 0 for unmapped aliases. */
  readonly credits: number;
}

export interface ExternalSpendMismatch {
  readonly code: "external_spend_mismatch";
  /** Σ |commit| over in-window ledger entries (integer µc, D-12). */
  readonly ledgerCommitSum: number;
  /** The provider-derived spend in WHOLE CREDITS (spendCreditsForModel math). */
  readonly externalSpendCredits: number;
  /** spend µc − ledgerCommitSum (integer µc). */
  readonly delta: number;
  readonly byModel: readonly ModelSpendRow[];
}

export interface NegativeBalance {
  readonly code: "negative_balance";
  readonly balance: number;
}

export type Discrepancy =
  | LedgerUsageMismatch
  | ZombieReserve
  | ExternalSpendMismatch
  | NegativeBalance;

// ─────────────────────────────────────────────────────────────────────────────
// External spend source (LiteLLM) — optional seam
// ─────────────────────────────────────────────────────────────────────────────

export type SpendFailureCode =
  | "unconfigured"
  | "unreachable"
  | "timeout"
  | "unauthorized"
  | "upstream_error"
  | "bad_response";

/** Typed, redacted failure — fixed human strings, never URLs/keys/bodies. */
export interface SpendFailure {
  readonly code: SpendFailureCode;
  readonly reason: string;
}

export type SpendResult =
  | { readonly ok: true; readonly models: readonly ModelSpendRow[] }
  | { readonly ok: false; readonly failure: SpendFailure };

/**
 * The external spend seam. `spendForWindow` NEVER throws — every failure is a
 * typed SpendFailure; the report degrades to local-only facts.
 */
export interface SpendSource {
  readonly kind: "litellm";
  spendForWindow(window: ReconcileWindow): Promise<SpendResult>;
}

export interface SpendSourceOptions {
  /**
   * Explicit spend credential (worker wiring). When absent, falls back to the
   * LITELLM_SPEND_KEY process var (the proxy MASTER key — ops-only, see the
   * header recipe). Never the chat platform key: spend endpoints are
   * master-key-protected admin routes (deploy/litellm/config.yaml).
   */
  readonly spendApiKey?: string;
  /** Test seam; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** Logger for the redacted fetch-failure breadcrumb (sha256 URL prefix only). */
  readonly logger?: Logger;
}

const SPEND_KEY_ENV_VAR = "LITELLM_SPEND_KEY";
const DEFAULT_SPEND_TIMEOUT_MS = 10_000;

/** Credential hygiene (both the process-env fallback and the explicit option). */
function isPlausibleSpendKey(value: string): boolean {
  return value.length >= 8 && value.length <= 512;
}

/**
 * process.env fallback (law-#12 precedent: billing.ts's
 * STRIPE_BLOCKED_TRIAL_DOMAINS — the var is intentionally NOT in the shared
 * env schema, which this task does not own). Returns null when unset/short —
 * the local/test reality: createSpendSource ⇒ null ⇒ local-ledger-only.
 */
function readSpendKeyFromProcessEnv(): string | null {
  const raw = process.env[SPEND_KEY_ENV_VAR];
  if (typeof raw !== "string" || !isPlausibleSpendKey(raw)) return null;
  return raw;
}

/** Per-model spend: the M4-A commit math applied to aggregate token totals. */
export function spendCreditsForModel(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const descriptor = MODEL_CATALOG[model as ModelId];
  if (descriptor === undefined) return 0; // unmapped alias — surfaced, not billed
  const credits =
    (inputTokens / 1000) * descriptor.creditsPer1kInput +
    (outputTokens / 1000) * descriptor.creditsPer1kOutput;
  return Math.max(0, Math.ceil(credits));
}

/** Zod shape of the LiteLLM per-model spend response (law #2: every boundary). */
const SPEND_MODELS_RESPONSE_SCHEMA = z.object({
  data: z.array(
    z.object({
      model_name: z.string().min(1),
      total_prompt_tokens: z.number().int().nonnegative().catch(0),
      total_completion_tokens: z.number().int().nonnegative().catch(0),
    }),
  ),
});

/**
 * Live LiteLLM spend source. GET {baseUrl}/global/spend/models?start_date=…&
 * end_date=… (master-key admin route, docs/deploy/LITELLM.md §3/§7). The key
 * lives in a closure and never crosses into reports, logs, or errors.
 */
export class LiteLLMSpendSource implements SpendSource {
  readonly kind = "litellm" as const;
  private readonly baseUrl: string;
  private readonly spendApiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly logger: Logger | null;

  constructor(options: {
    readonly baseUrl: string;
    readonly spendApiKey: string;
    readonly fetchImpl?: typeof fetch;
    readonly timeoutMs?: number;
    readonly logger?: Logger;
  }) {
    this.baseUrl = options.baseUrl;
    this.spendApiKey = options.spendApiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SPEND_TIMEOUT_MS;
    this.logger = options.logger ?? null;
  }

  async spendForWindow(window: ReconcileWindow): Promise<SpendResult> {
    const url =
      `${this.baseUrl.replace(/\/+$/, "")}/global/spend/models` +
      `?start_date=${encodeURIComponent(window.sinceTs.toISOString())}` +
      `&end_date=${encodeURIComponent(window.uptoTs.toISOString())}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: { authorization: `Bearer ${this.spendApiKey}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      return { ok: false, failure: this.fetchFailure(error) };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        failure: { code: "unauthorized", reason: "The spend service rejected the credential." },
      };
    }
    if (!response.ok) {
      this.logFailure("upstream_error", response.status);
      return {
        ok: false,
        failure: { code: "upstream_error", reason: "The spend service returned an error." },
      };
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return {
        ok: false,
        failure: {
          code: "bad_response",
          reason: "The spend service returned an unreadable response.",
        },
      };
    }
    const parsed = SPEND_MODELS_RESPONSE_SCHEMA.safeParse(json);
    if (!parsed.success) {
      return {
        ok: false,
        failure: {
          code: "bad_response",
          reason: "The spend service returned an unexpected response shape.",
        },
      };
    }
    const models: ModelSpendRow[] = parsed.data.data.map((row) => ({
      model: row.model_name,
      inputTokens: row.total_prompt_tokens,
      outputTokens: row.total_completion_tokens,
      credits: spendCreditsForModel(
        row.model_name,
        row.total_prompt_tokens,
        row.total_completion_tokens,
      ),
    }));
    return { ok: true, models };
  }

  /** M4-A redaction pattern: fixed reason + a sha256 prefix of the URL — never the URL, key, or body. */
  private fetchFailure(error: unknown): SpendFailure {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      this.logFailure("timeout", null);
      return { code: "timeout", reason: "The spend service did not respond in time." };
    }
    this.logFailure("unreachable", null);
    return { code: "unreachable", reason: "The spend service is unreachable right now." };
  }

  private logFailure(code: SpendFailureCode, status: number | null): void {
    if (this.logger === null) return;
    this.logger.warn("reconcile_spend_fetch_failed", {
      code,
      status: status ?? undefined,
      urlFingerprint: createHash("sha256").update(this.baseUrl).digest("hex").slice(0, 16),
    });
  }
}

/**
 * The mission seam: returns null when the spend credential is unset (the
 * local/test reality — every deployment box without LITELLM_SPEND_KEY) so the
 * job degrades to local-ledger-only reconciliation.
 */
export function createSpendSource(
  env: Pick<StudioEnv, "litellm">,
  options: SpendSourceOptions = {},
): LiteLLMSpendSource | null {
  const explicit = options.spendApiKey;
  const spendApiKey = explicit === undefined ? readSpendKeyFromProcessEnv() : explicit;
  if (spendApiKey === null || spendApiKey === undefined) return null;
  if (explicit !== undefined && !isPlausibleSpendKey(explicit)) return null;
  if (typeof env.litellm.baseUrl !== "string" || env.litellm.baseUrl.length === 0) return null;
  return new LiteLLMSpendSource({
    baseUrl: env.litellm.baseUrl,
    spendApiKey,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    logger: options.logger,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Injectable sources (pure-ish core; the default adapter walks the repos)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal run-row view the core needs (AgentRun satisfies it structurally).
 * D-12 row ruling: committedCredits is WHOLE CREDITS on the row — the core
 * converts to µc before folding it against ledger sums (W3-b02).
 */
export interface ReconcileRunView {
  readonly committedCredits: number;
  readonly status: string;
  readonly createdAt: Date;
}

export interface ScanResult<Row> {
  readonly entries: readonly Row[];
  /** True when the scan hit its cap — window sums above the cap are missing. */
  readonly truncated: boolean;
}

export interface ReconcileSources {
  /** Ledger entries with sinceTs ≤ createdAt < uptoTs (tenant-scoped). */
  readonly ledgerScan: (
    workspaceId: string,
    window: ReconcileWindow,
    limit: number,
  ) => Promise<ScanResult<DbLedgerEntry>>;
  /** Full ledger history of one run (for outstanding/zombie math). */
  readonly runLedger: (workspaceId: string, runId: string) => Promise<readonly DbLedgerEntry[]>;
  /** The run row, or null when missing (tenant-scoped; cross-tenant = null). */
  readonly runRow: (workspaceId: string, runId: string) => Promise<ReconcileRunView | null>;
  /** Renders created in the window (tenant-scoped). */
  readonly renderScan: (
    workspaceId: string,
    window: ReconcileWindow,
    limit: number,
  ) => Promise<ScanResult<Render>>;
  /** balance = SUM(amount) over the workspace ledger (D-20). */
  readonly balance: (workspaceId: string) => Promise<number>;
  /** Appends the true-up adjust — kind "adjust", idempotent, never negative-making. */
  readonly appendAdjust: (
    workspaceId: string,
    input: { readonly amount: number; readonly idempotencyKey: string; readonly metadata: unknown },
  ) => Promise<{ readonly entry: DbLedgerEntry; readonly replayed: boolean }>;
}

const LEDGER_PAGE_SIZE = 100;

/**
 * Repo-backed default sources. Every call is tenant-scoped (law #3): the
 * walks go through repos.ledger.list / repos.renders.list (workspaceId
 * first), per-run lookups through repos.runs.get. The windowed walks page
 * newest-first and stop at the first entry older than sinceTs — a db-side
 * windowed aggregate is the documented follow-up (the M4-K note).
 */
export function createRepoReconcileSources(repos: Repos): ReconcileSources {
  return {
    async ledgerScan(workspaceId, window, limit) {
      const entries: DbLedgerEntry[] = [];
      let cursor: string | null = null;
      let truncated = false;
      for (;;) {
        const page = await repos.ledger.list(workspaceId, {
          cursor,
          limit: LEDGER_PAGE_SIZE,
        });
        let pastWindow = false;
        for (const entry of page.items) {
          if (entry.createdAt.getTime() >= window.uptoTs.getTime()) continue; // newer than window
          if (entry.createdAt.getTime() < window.sinceTs.getTime()) {
            pastWindow = true; // sorted desc — everything after is older
            break;
          }
          if (entries.length >= limit) {
            truncated = true;
            pastWindow = true;
            break;
          }
          entries.push(entry);
        }
        if (pastWindow || page.nextCursor === null || page.items.length === 0) {
          return { entries, truncated };
        }
        cursor = page.nextCursor;
      }
    },

    async runLedger(workspaceId, runId) {
      const entries: DbLedgerEntry[] = [];
      let cursor: string | null = null;
      for (;;) {
        const page = await repos.ledger.list(workspaceId, {
          runId,
          cursor,
          limit: LEDGER_PAGE_SIZE,
        });
        entries.push(...page.items);
        if (page.nextCursor === null || entries.length >= DEFAULT_SCAN_LIMIT) {
          return entries.slice(0, DEFAULT_SCAN_LIMIT);
        }
        cursor = page.nextCursor;
      }
    },

    async runRow(workspaceId, runId) {
      try {
        const { run } = await repos.runs.get(workspaceId, runId);
        return {
          committedCredits: run.committedCredits,
          status: run.status,
          createdAt: run.createdAt,
        };
      } catch (error) {
        if (isDbError(error) && error.code === "NOT_FOUND") return null;
        throw error;
      }
    },

    async renderScan(workspaceId, window, limit) {
      const renders: Render[] = [];
      let cursor: string | null = null;
      let truncated = false;
      for (;;) {
        const page = await repos.renders.list(workspaceId, { cursor, limit: LEDGER_PAGE_SIZE });
        let pastWindow = false;
        for (const render of page.items) {
          if (render.createdAt.getTime() >= window.uptoTs.getTime()) continue;
          if (render.createdAt.getTime() < window.sinceTs.getTime()) {
            pastWindow = true;
            break;
          }
          if (renders.length >= limit) {
            truncated = true;
            pastWindow = true;
            break;
          }
          renders.push(render);
        }
        if (pastWindow || page.nextCursor === null || page.items.length === 0) {
          return { entries: renders, truncated };
        }
        cursor = page.nextCursor;
      }
    },

    balance(workspaceId) {
      return repos.ledger.balance(workspaceId);
    },

    async appendAdjust(workspaceId, input) {
      const result = await repos.ledger.adjust(workspaceId, {
        amount: input.amount,
        idempotencyKey: input.idempotencyKey,
        metadata: input.metadata,
      });
      return { entry: result.entry, replayed: result.replayed };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────────

export interface ReconcileLedgerSums {
  readonly grants: number;
  /** Σ |reserve| in window (positive magnitude). */
  readonly reserves: number;
  /** Σ per-run outstanding holds for runs discovered in the window. */
  readonly outstandingReserves: number;
  /** Σ |commit| in window (positive magnitude). */
  readonly commits: number;
  readonly refunds: number;
  /** Σ signed adjust amounts in window (corrections may be negative). */
  readonly adjusts: number;
  readonly entryCount: number;
}

export interface ReconcileUsageSums {
  readonly runs: {
    readonly discovered: number;
    readonly settledInWindow: number;
    /** Σ run-row committedCredits converted to integer µc (D-12 row ruling). */
    readonly committedCredits: number;
  };
  readonly renders: { readonly count: number; readonly credits: number };
  /** runs + renders usage, integer µc — same dialect as the ledger sums. */
  readonly usageSum: number;
}

export interface ReconcileExternalSection {
  readonly source: "none" | "litellm";
  readonly spendCredits: number | null;
  readonly perModel: readonly ModelSpendRow[];
  readonly unknownModels: readonly string[];
  readonly error: SpendFailure | null;
}

export interface ReconcileActionSection {
  readonly attempted: boolean;
  readonly applied: boolean;
  readonly replayed: boolean;
  readonly adjustAmount: number | null;
  readonly entryId: string | null;
  readonly balanceAfter: number | null;
  /** Safe machine reason the action did not land ("report_only", "no_mismatch", …). */
  readonly skippedReason: string | null;
}

export interface ReconcileReport {
  readonly workspaceId: string;
  readonly window: { readonly sinceTs: string; readonly uptoTs: string };
  readonly mode: ReconcileMode;
  readonly ledger: ReconcileLedgerSums;
  readonly usage: ReconcileUsageSums;
  readonly balance: number;
  readonly discrepancies: readonly Discrepancy[];
  readonly external: ReconcileExternalSection;
  readonly action: ReconcileActionSection;
  readonly scan: { readonly truncated: boolean; readonly scannedEntries: number };
  readonly generatedAt: string;
}

export interface ReconcileDeps {
  readonly sources: ReconcileSources;
  readonly spend?: SpendSource | null;
  readonly logger?: Logger;
}

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True-up idempotency key per (workspace, windowStart) — replaying the same
 * window is free; a different windowStart is a NEW true-up by definition.
 */
export function reconcileAdjustIdempotencyKey(workspaceId: string, sinceTs: Date): string {
  return deriveIdempotencyKey("recon", workspaceId, sinceTs.getTime());
}

// ─────────────────────────────────────────────────────────────────────────────
// Core
// ─────────────────────────────────────────────────────────────────────────────

function foldKindSums(entries: readonly DbLedgerEntry[]): ReconcileLedgerSums & {
  runIds: ReadonlySet<string>;
} {
  let grants = 0;
  let reserves = 0;
  let commits = 0;
  let refunds = 0;
  let adjusts = 0;
  const runIds = new Set<string>();
  for (const entry of entries) {
    if (entry.runId !== null) runIds.add(entry.runId);
    switch (entry.kind) {
      case "grant":
        grants += entry.amount;
        break;
      case "reserve":
        reserves -= entry.amount; // amounts are −N
        break;
      case "commit":
        commits -= entry.amount; // amounts are −M
        break;
      case "refund":
        refunds += entry.amount;
        break;
      case "adjust":
        adjusts += entry.amount;
        break;
    }
  }
  return {
    grants,
    reserves,
    commits,
    refunds,
    adjusts,
    outstandingReserves: 0,
    entryCount: entries.length,
    runIds,
  };
}

/**
 * Reconcile one workspace over [sinceTs, uptoTs). Never writes unless
 * `options.mode === "reconcile"` AND a ledger-vs-usage delta exists; the
 * append (when it happens) is idempotent per (workspace, sinceTs).
 */
export async function reconcileWorkspace(
  workspaceId: string,
  window: ReconcileWindow,
  deps: ReconcileDeps,
  options: ReconcileOptions = {},
): Promise<ReconcileReport> {
  const now = options.now ?? ((): Date => new Date());
  const nowDate = now();
  guardWindow(window, nowDate);
  const mode: ReconcileMode = options.mode ?? "report";
  const graceMs = options.zombieGraceMs ?? DEFAULT_ZOMBIE_GRACE_MS;
  const scanLimit = options.scanLimit ?? DEFAULT_SCAN_LIMIT;
  const logger = deps.logger ?? null;

  // (a) ledger side — windowed walk
  const scan = await deps.sources.ledgerScan(workspaceId, window, scanLimit);
  const sums = foldKindSums(scan.entries);

  // per-run detail: outstanding holds, zombie age, run-row drift
  const zombies: ZombieReserve[] = [];
  const runDrift: RunRowDrift[] = [];
  let outstandingTotal = 0;
  const settledInWindow = new Set<string>();
  for (const entry of scan.entries) {
    if (entry.kind === "commit" && entry.runId !== null) settledInWindow.add(entry.runId);
  }
  const usageByRun = new Map<string, number>();
  for (const runId of sums.runIds) {
    const runEntries = await deps.sources.runLedger(workspaceId, runId);
    const outstanding = outstandingReserve(runEntries);
    outstandingTotal += outstanding;
    const row = await deps.sources.runRow(workspaceId, runId);
    const ledgerCommits = -runEntries
      .filter((entry) => entry.kind === "commit")
      .reduce((total, entry) => total + entry.amount, 0);
    if (settledInWindow.has(runId)) {
      // W3-b02 (w1-a27 S255 HIGH): the run row speaks WHOLE CREDITS (D-12 row
      // ruling — routes/turn.ts heartbeats the Σ committedCreditsFor usage
      // into it), while the ledger sums above are integer µc. Convert the row
      // BEFORE folding: the pre-fix raw mix reported a spurious
      // ledger_usage_mismatch on every turn-world workspace, and a
      // reconcile-mode true-up then granted the whole commit back as balance.
      const rowCommittedMicro = Math.round((row?.committedCredits ?? 0) * MICROCREDITS_PER_CREDIT);
      usageByRun.set(runId, rowCommittedMicro);
      if (rowCommittedMicro !== ledgerCommits) {
        runDrift.push({ runId, ledgerCommits, rowCommitted: rowCommittedMicro });
      }
    }
    if (outstanding > 0) {
      const newestReserve = runEntries
        .filter((entry) => entry.kind === "reserve")
        .reduce(
          (newest, entry) => (entry.createdAt > newest ? entry.createdAt : newest),
          new Date(0),
        );
      const ageMs = Math.max(0, nowDate.getTime() - newestReserve.getTime());
      if (ageMs > graceMs) {
        zombies.push({
          code: "zombie_reserve",
          runId,
          outstanding,
          reservedAt: newestReserve.toISOString(),
          ageMs,
          runStatus: row?.status ?? "missing",
        });
      }
    }
  }

  // (b) usage side — runs table + renders table. usageByRun already holds the
  // run rows converted to µc (D-12 row ruling — whole credits on disk); the
  // renders table's credits column is µc natively (the render reserve/commit
  // dialect). usageSum therefore speaks µc, like the ledger side it is
  // compared against.
  const renderScan = await deps.sources.renderScan(workspaceId, window, scanLimit);
  const rendersUsage = renderScan.entries.reduce((total, render) => total + render.credits, 0);
  const runsUsage = [...usageByRun.values()].reduce((total, value) => total + value, 0);
  const usageSum = runsUsage + rendersUsage;

  const discrepancies: Discrepancy[] = [];
  const mismatch: LedgerUsageMismatch | null =
    usageSum !== sums.commits
      ? {
          code: "ledger_usage_mismatch",
          ledgerCommitSum: sums.commits,
          usageSum,
          delta: usageSum - sums.commits,
          runsUsage,
          rendersUsage,
          runCount: usageByRun.size,
          renderCount: renderScan.entries.length,
          runDrift,
        }
      : null;
  if (mismatch !== null) discrepancies.push(mismatch);
  for (const zombie of zombies) discrepancies.push(zombie);

  // (c) external side — optional LiteLLM spend
  const external: {
    source: "none" | "litellm";
    spendCredits: number | null;
    perModel: readonly ModelSpendRow[];
    unknownModels: readonly string[];
    error: SpendFailure | null;
  } = {
    source: "none",
    spendCredits: null,
    perModel: [],
    unknownModels: [],
    error: null,
  };
  const spendSource = deps.spend ?? null;
  if (spendSource !== null) {
    external.source = "litellm";
    const result = await spendSource.spendForWindow(window);
    if (result.ok) {
      let spendTotal = 0;
      const perModel: ModelSpendRow[] = [];
      const unknown: string[] = [];
      for (const row of result.models) {
        perModel.push(row);
        spendTotal += row.credits;
        if (MODEL_CATALOG[row.model as ModelId] === undefined) unknown.push(row.model);
      }
      external.perModel = perModel;
      external.spendCredits = spendTotal;
      external.unknownModels = unknown;
      // W3-b02: spendCreditsForModel yields WHOLE CREDITS while sums.commits
      // is integer µc — compare like-for-like by converting the spend to µc
      // (the pre-fix raw compare flagged every configured deployment).
      const spendMicro = spendTotal * MICROCREDITS_PER_CREDIT;
      if (spendMicro !== sums.commits) {
        discrepancies.push({
          code: "external_spend_mismatch",
          ledgerCommitSum: sums.commits,
          externalSpendCredits: spendTotal,
          delta: spendMicro - sums.commits,
          byModel: perModel,
        });
      }
    } else {
      external.error = result.failure;
      if (logger !== null) {
        logger.warn("reconcile_spend_source_failed", {
          workspaceId,
          code: result.failure.code,
        });
      }
    }
  }

  // invariant check (D-12)
  const balance = await deps.sources.balance(workspaceId);
  if (balance < 0) {
    discrepancies.push({ code: "negative_balance", balance });
  }

  // true-up action — only in reconcile mode, only for a real delta
  let action: ReconcileActionSection = {
    attempted: false,
    applied: false,
    replayed: false,
    adjustAmount: null,
    entryId: null,
    balanceAfter: null,
    skippedReason: null,
  };
  if (mismatch === null) {
    action = { ...action, skippedReason: "no_mismatch" };
  } else if (mode === "report") {
    action = { ...action, skippedReason: "report_only" };
  } else {
    const adjustAmount = -mismatch.delta; // make the ledger agree with usage
    action = { ...action, attempted: true, adjustAmount };
    if (adjustAmount === 0) {
      action = { ...action, skippedReason: "no_mismatch" };
    } else {
      try {
        const appended = await deps.sources.appendAdjust(workspaceId, {
          amount: adjustAmount,
          idempotencyKey: reconcileAdjustIdempotencyKey(workspaceId, window.sinceTs),
          metadata: {
            kind: "reconciliation_true_up",
            note: options.note ?? "Reconciliation true-up: ledger commits vs recorded usage.",
            windowStart: window.sinceTs.toISOString(),
            windowEnd: window.uptoTs.toISOString(),
            ledgerCommitSum: mismatch.ledgerCommitSum,
            usageSum: mismatch.usageSum,
            delta: mismatch.delta,
            renderCount: mismatch.renderCount,
            runCount: mismatch.runCount,
          },
        });
        action = {
          ...action,
          applied: true,
          replayed: appended.replayed,
          entryId: appended.entry.id,
          balanceAfter: appended.entry.balanceAfter,
          skippedReason: null,
        };
      } catch (error) {
        // Typed ledger refusal (e.g. the adjust would make the balance
        // negative — D-12). Safe message only; the cause stays server-side.
        const reason =
          isDbError(error) && error.code === "VALIDATION_FAILED"
            ? "adjust_refused_by_ledger"
            : "adjust_failed";
        action = { ...action, skippedReason: reason };
        if (logger !== null) {
          logger.error("reconcile_adjust_failed", { workspaceId, reason });
        }
      }
    }
  }

  const report: ReconcileReport = {
    workspaceId,
    window: { sinceTs: window.sinceTs.toISOString(), uptoTs: window.uptoTs.toISOString() },
    mode,
    ledger: {
      grants: sums.grants,
      reserves: sums.reserves,
      outstandingReserves: outstandingTotal,
      commits: sums.commits,
      refunds: sums.refunds,
      adjusts: sums.adjusts,
      entryCount: sums.entryCount,
    },
    usage: {
      runs: {
        discovered: sums.runIds.size,
        settledInWindow: usageByRun.size,
        committedCredits: runsUsage,
      },
      renders: { count: renderScan.entries.length, credits: rendersUsage },
      usageSum,
    },
    balance,
    discrepancies,
    external,
    action,
    scan: {
      truncated: scan.truncated || renderScan.truncated,
      scannedEntries: scan.entries.length,
    },
    generatedAt: nowDate.toISOString(),
  };
  if (logger !== null) {
    logger.info("reconcile_completed", {
      workspaceId,
      mode,
      discrepancies: discrepancies.length,
      truncated: report.scan.truncated,
    });
  }
  return report;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sweep (cron/worker entry point — NOT wired to a scheduler in v1)
// ─────────────────────────────────────────────────────────────────────────────

export interface SweepOptions {
  /** Repos bundle (the worker builds it: createRepos(createDb(DATABASE_URL))). */
  readonly repos: Repos;
  /** Sources override (tests / custom walkers); defaults to the repo adapter. */
  readonly sources?: ReconcileSources;
  /** The workspaces to sweep (see the operator recipe — no enumeration repo yet). */
  readonly workspaceIds: readonly string[];
  /** Defaults to the trailing 24 hours ending at now. */
  readonly window?: ReconcileWindow;
  readonly mode?: ReconcileMode;
  readonly zombieGraceMs?: number;
  readonly scanLimit?: number;
  readonly note?: string;
  /** Optional spend source (createSpendSource(env) — null ⇒ local-only). */
  readonly spend?: SpendSource | null;
  readonly logger?: Logger;
  readonly now?: () => Date;
}

export interface SweepWorkspaceResult {
  readonly workspaceId: string;
  readonly report: ReconcileReport | null;
  /** Safe machine reason the workspace could not be reconciled. */
  readonly failure: string | null;
}

export interface ReconcileSweepSummary {
  readonly window: { readonly sinceTs: string; readonly uptoTs: string };
  readonly mode: ReconcileMode;
  readonly workspacesChecked: number;
  readonly workspacesWithDiscrepancies: number;
  readonly workspacesFailed: number;
  readonly results: readonly SweepWorkspaceResult[];
}

/**
 * Sweep N workspaces serially. A per-workspace failure NEVER aborts the sweep
 * — it lands as a typed failure entry (the cron keeps going).
 */
export async function runReconciliationSweep(
  options: SweepOptions,
): Promise<ReconcileSweepSummary> {
  const now = options.now ?? ((): Date => new Date());
  const upto = options.window?.uptoTs ?? now();
  const since = options.window?.sinceTs ?? new Date(upto.getTime() - DAY_MS); // 24h default
  const window: ReconcileWindow = { sinceTs: since, uptoTs: upto };
  const mode: ReconcileMode = options.mode ?? "report";
  const sources = options.sources ?? createRepoReconcileSources(options.repos);
  const results: SweepWorkspaceResult[] = [];
  let withDiscrepancies = 0;
  let failed = 0;
  for (const workspaceId of options.workspaceIds) {
    try {
      const report = await reconcileWorkspace(
        workspaceId,
        window,
        { sources, spend: options.spend ?? null, logger: options.logger },
        {
          mode,
          zombieGraceMs: options.zombieGraceMs,
          scanLimit: options.scanLimit,
          note: options.note,
          now,
        },
      );
      results.push({ workspaceId, report, failure: null });
      if (report.discrepancies.length > 0) withDiscrepancies += 1;
    } catch (error) {
      failed += 1;
      const failure = isDbError(error) ? "workspace_query_failed" : "workspace_reconcile_failed";
      options.logger?.error("reconcile_sweep_workspace_failed", { workspaceId, failure });
      results.push({ workspaceId, report: null, failure });
    }
  }
  return {
    window: { sinceTs: window.sinceTs.toISOString(), uptoTs: window.uptoTs.toISOString() },
    mode,
    workspacesChecked: results.length,
    workspacesWithDiscrepancies: withDiscrepancies,
    workspacesFailed: failed,
    results,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Route request schema (local to this module — contracts routes are outside
// this task's ownership, law #12)
// ─────────────────────────────────────────────────────────────────────────────

export const RECONCILE_REQUEST_SCHEMA = z.strictObject({
  sinceTs: ISO8601_SCHEMA,
  uptoTs: ISO8601_SCHEMA,
  mode: z.enum(["report", "reconcile"]).optional(),
  note: z.string().min(1).max(280).optional(),
});

export interface ReconcileRequest {
  readonly sinceTs: string;
  readonly uptoTs: string;
  readonly mode?: ReconcileMode;
  readonly note?: string;
}

/** 24h sweep default window. */
const DAY_MS = 86_400_000;
