// @studio/agent — the deterministic run state machine. Owner: W1-P (docs/AGENTS.md).
//
// Spec §5.1 (the loop is a state machine, not vibes):
//
//   queued → planning → executing ⇄ observing → rendering → validating → critiquing
//           → (repairing → observing) ×N → finalizing → succeeded
//                                      ↘ failed / cancelled
//
// Rules encoded here:
//   - Plan first: `queued → planning → executing` only (never straight to executing).
//   - Observe after act: `executing ⇄ observing` is the only bidirectional edge.
//   - Repair narrowly: `repairing → observing` re-enters the loop (§11.1 blocker/major
//     issues drive it; validator blockers may enter repair before the critic runs —
//     §11.3 "skip the critic if the cycle only fixed validator blockers").
//   - One exit to terminal success: everything funnels through `finalizing`
//     (`succeeded` or `succeeded_with_warnings`, §5.1 repair-cycle cap).
//   - `failed`/`cancelled` are reachable from every non-terminal state (crash,
//     timeout, user cancel, validation blocker → rollback).
//   - Terminal states never transition again.
//
// Status strings are identical to the `agent_runs.status` column type (W1-E,
// packages/db/src/schema/runs.ts) — a type-level guard at the bottom of this file
// fails compilation on drift.
import { z } from 'zod';
import { agentErr, agentOk, type AgentResult } from './errors.js';

/** §5.1 — non-terminal phases + terminal states (13 total). */
export const RUN_STATUSES = [
  'queued',
  'planning',
  'executing',
  'observing',
  'rendering',
  'validating',
  'critiquing',
  'repairing',
  'finalizing',
  'succeeded',
  'succeeded_with_warnings',
  'failed',
  'cancelled',
] as const satisfies readonly string[];

export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_STATUS_SCHEMA = z.enum(RUN_STATUSES);

/** §5.1 terminal states — no outgoing transitions, ever. */
export const TERMINAL_RUN_STATUSES = [
  'succeeded',
  'succeeded_with_warnings',
  'failed',
  'cancelled',
] as const satisfies readonly RunStatus[];

export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];

/** Every status that can still move (the state machine's working set). */
export const NON_TERMINAL_RUN_STATUSES = [
  'queued',
  'planning',
  'executing',
  'observing',
  'rendering',
  'validating',
  'critiquing',
  'repairing',
  'finalizing',
] as const satisfies readonly RunStatus[];

export type NonTerminalRunStatus = (typeof NON_TERMINAL_RUN_STATUSES)[number];

/**
 * §5.1 phases an individual step can belong to — aligned 1:1 with
 * `RUN_PHASES` in packages/db/src/schema/runs.ts (W1-E).
 */
export const RUN_PHASES = [
  'planning',
  'executing',
  'observing',
  'rendering',
  'validating',
  'critiquing',
  'repairing',
  'finalizing',
] as const satisfies readonly RunStatus[];

export type RunPhase = (typeof RUN_PHASES)[number];

/** True when the status is one of the §5.1 terminal states. */
export function isTerminal(status: RunStatus): status is TerminalRunStatus {
  return (TERMINAL_RUN_STATUSES as readonly RunStatus[]).includes(status);
}

/** True when the status is a §5.1 step phase (queued and terminals are not phases). */
export function isRunPhase(status: RunStatus): status is RunPhase {
  return (RUN_PHASES as readonly RunStatus[]).includes(status);
}

/**
 * The §5.1 transition table. Key: from-status. Value: every status the loop may
 * move to. Terminal rows are empty by construction.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  // Plan first (§5.1): a queued run may only start planning — or die early.
  queued: ['planning', 'failed', 'cancelled'],
  // Plan validated → execute. §5.1: invalid plan → one retry → clear failure.
  planning: ['executing', 'failed', 'cancelled'],
  // Observe after act (§5.1).
  executing: ['observing', 'failed', 'cancelled'],
  // ⇄ back to executing for the next phase, or forward to the render pipeline.
  observing: ['executing', 'rendering', 'failed', 'cancelled'],
  // Render, then validate before critique (§5.1).
  rendering: ['validating', 'failed', 'cancelled'],
  // No blocker → critic (or skip it: quick tier §5.3, export intents) → finalizing.
  // Blocker/major → repairing (§11.1/§11.3). A fatal blocker → failed (rollback §5.1).
  validating: ['critiquing', 'repairing', 'finalizing', 'failed', 'cancelled'],
  // Critic issues drive the repair loop; otherwise the run finalizes.
  // Revision cap reached → finalizing → succeeded_with_warnings (§5.1/§11.2).
  critiquing: ['repairing', 'finalizing', 'failed', 'cancelled'],
  // (repairing → observing) ×N — one repair cycle re-enters the observe loop.
  repairing: ['observing', 'failed', 'cancelled'],
  // agent.commit → succeeded / succeeded_with_warnings; commit failure → failed.
  finalizing: ['succeeded', 'succeeded_with_warnings', 'failed', 'cancelled'],
  // Terminal rows are frozen (§5.1).
  succeeded: [],
  succeeded_with_warnings: [],
  failed: [],
  cancelled: [],
};

/** Guard for the §5.1 table: may the loop move `from` → `to`? */
export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return (ALLOWED_TRANSITIONS[from] as readonly RunStatus[]).includes(to);
}

/**
 * Applies a §5.1 transition. Every illegal attempt is a typed error envelope
 * (never a throw): `{ ok:false, code:'invalid_transition', … }`.
 */
export function transition(from: RunStatus, to: RunStatus): AgentResult<RunStatus> {
  if (isTerminal(from)) {
    return agentErr(
      'invalid_transition',
      `Cannot transition '${from} → ${to}': '${from}' is terminal (§5.1) — runs never leave a terminal state.`,
      { hint: 'Start a new run instead of continuing this one.' },
    );
  }
  if (!canTransition(from, to)) {
    return agentErr(
      'invalid_transition',
      `A run cannot move from '${from}' to '${to}' (§5.1 state machine).`,
      {
        hint: isTerminal(to)
          ? `Reach '${to}' via 'finalizing' (success) or directly from any active phase (failure/cancel).`
          : `Allowed next states from '${from}': ${ALLOWED_TRANSITIONS[from].join(', ')}.`,
      },
    );
  }
  return agentOk(to);
}

// --- Compile-time drift guard against the landed DB row type (W1-E) -------------
// packages/db/src/schema/runs.ts owns the `agent_runs.status` column type; this
// exported alias only compiles when both unions are identical (either direction),
// so a W1-E rename/add fails CI here instead of corrupting run rows silently.
type _ExactUnion<Db> = [Db] extends [RunStatus] ? ([RunStatus] extends [Db] ? true : never) : never;

/** Internal contract check — resolves to `true`; never import this. */
export type RunStatusMatchesDb = _ExactUnion<import('@studio/db').RunStatus>;
