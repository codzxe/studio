// W1-P — §5.1 state machine: exhaustive legal/illegal transition tables.
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TRANSITIONS,
  RUN_PHASES,
  RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  canTransition,
  isRunPhase,
  isTerminal,
  transition,
  type RunStatus,
} from '../src/state.js';

// The §5.1 machine, written out independently of the implementation so a typo in
// ALLOWED_TRANSITIONS fails here instead of corrupting run rows.
const expectedLegal: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ['planning', 'failed', 'cancelled'],
  planning: ['executing', 'failed', 'cancelled'],
  executing: ['observing', 'failed', 'cancelled'],
  observing: ['executing', 'rendering', 'failed', 'cancelled'],
  rendering: ['validating', 'failed', 'cancelled'],
  validating: ['critiquing', 'repairing', 'finalizing', 'failed', 'cancelled'],
  critiquing: ['repairing', 'finalizing', 'failed', 'cancelled'],
  repairing: ['observing', 'failed', 'cancelled'],
  finalizing: ['succeeded', 'succeeded_with_warnings', 'failed', 'cancelled'],
  succeeded: [],
  succeeded_with_warnings: [],
  failed: [],
  cancelled: [],
};

describe('state: §5.1 legal transitions (table-driven)', () => {
  it.each(RUN_STATUSES)('%s allows exactly the §5.1 successors', (from) => {
    const allowed = expectedLegal[from];
    expect(ALLOWED_TRANSITIONS[from]).toEqual([...allowed]);
    // Everything listed as legal passes both the guard and the typed transition.
    for (const to of allowed) {
      expect(canTransition(from, to)).toBe(true);
      const result = transition(from, to);
      expect(result).toEqual({ ok: true, value: to });
    }
  });

  it('totals 32 legal transitions across the machine', () => {
    const total = RUN_STATUSES.reduce((sum, from) => sum + ALLOWED_TRANSITIONS[from].length, 0);
    expect(total).toBe(32);
  });
});

describe('state: illegal transitions are typed errors (exhaustive 13×13)', () => {
  it.each(RUN_STATUSES)('%s rejects every status outside its successor set', (from) => {
    const legal = new Set<string>(expectedLegal[from]);
    for (const to of RUN_STATUSES) {
      if (legal.has(to)) continue;
      expect(canTransition(from, to), `${from} → ${to}`).toBe(false);
      const result = transition(from, to);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.code).toBe('invalid_transition');
      expect(result.message).toContain(from);
      expect(result.message).toContain(to);
      expect(typeof result.hint).toBe('string');
    }
  });

  it('names the state machine and the spec in the error', () => {
    const result = transition('queued', 'executing');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('invalid_transition');
    expect(result.message).toContain('§5.1');
    expect(result.hint).toContain('planning');
  });
});

describe('state: §5.1 loop invariants', () => {
  it('terminal states never transition', () => {
    for (const terminal of TERMINAL_RUN_STATUSES) {
      expect(isTerminal(terminal)).toBe(true);
      const result = transition(terminal, 'queued');
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.message).toContain('terminal');
    }
  });

  it('isTerminal is false for every working state', () => {
    const working = RUN_STATUSES.filter((status) => !isTerminal(status));
    expect(working).toHaveLength(9);
    for (const status of working) expect(isTerminal(status)).toBe(false);
  });

  it('plan first: queued can never skip straight to executing', () => {
    expect(canTransition('queued', 'executing')).toBe(false);
    expect(canTransition('queued', 'rendering')).toBe(false);
    expect(canTransition('queued', 'succeeded')).toBe(false);
    expect(canTransition('queued', 'planning')).toBe(true);
  });

  it('observe after act is the only bidirectional edge', () => {
    expect(canTransition('executing', 'observing')).toBe(true);
    expect(canTransition('observing', 'executing')).toBe(true);
    expect(canTransition('rendering', 'observing')).toBe(false);
    expect(canTransition('validating', 'observing')).toBe(false);
  });

  it('failed and cancelled are reachable from every non-terminal state', () => {
    for (const from of RUN_STATUSES) {
      if (isTerminal(from)) continue;
      expect(canTransition(from, 'failed'), `${from} → failed`).toBe(true);
      expect(canTransition(from, 'cancelled'), `${from} → cancelled`).toBe(true);
    }
  });

  it('success exits only through finalizing', () => {
    expect(canTransition('finalizing', 'succeeded')).toBe(true);
    expect(canTransition('finalizing', 'succeeded_with_warnings')).toBe(true);
    for (const from of RUN_STATUSES) {
      if (from === 'finalizing' || isTerminal(from)) continue;
      expect(canTransition(from, 'succeeded'), `${from} → succeeded`).toBe(false);
      expect(canTransition(from, 'succeeded_with_warnings'), `${from} → succeeded_with_warnings`).toBe(false);
    }
  });

  it('repair re-enters the loop through observing (×N)', () => {
    expect(canTransition('repairing', 'observing')).toBe(true);
    expect(canTransition('repairing', 'critiquing')).toBe(false);
    expect(canTransition('critiquing', 'repairing')).toBe(true);
    expect(canTransition('validating', 'repairing')).toBe(true); // §11.3 validator-driven repairs
  });

  it('phases are the eight non-queued working states (db RUN_PHASES alignment)', () => {
    expect(RUN_PHASES).toHaveLength(8);
    expect(isRunPhase('queued')).toBe(false);
    expect(isRunPhase('succeeded')).toBe(false);
    expect(isRunPhase('repairing')).toBe(true);
  });
});
