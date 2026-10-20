// @studio/engine-pool — SessionRegistry: the in-memory bookkeeping behind the pool.
// Pure logic, no I/O. Sessions are stored frozen and handed out as copies, so the only
// way to mutate state is through `update()`.

import { ACTIVE_SESSION_STATES, DEFAULT_IDLE_TIMEOUT_MS } from "./constants.js";
import { sessionNotFound, spawnFailed } from "./errors.js";
import type { EngineSession, EngineSessionState } from "./types.js";

export interface SessionRegistryOptions {
  /** Injectable clock (epoch ms) so idle math is deterministic in tests. */
  readonly clock?: () => number;
}

export interface ListFilter {
  readonly organizationId?: string;
  readonly states?: readonly EngineSessionState[];
}

export interface EvictionOptions {
  /** Idle age threshold; defaults to the 15-minute session idle timeout (§3.4). */
  readonly maxIdleMs?: number;
  /** Override "now" (tests); defaults to the registry clock. */
  readonly now?: number;
}

/** Fields callers may patch after registration; identity and tenant never change. */
export type SessionPatch = Partial<
  Pick<EngineSession, "documentId" | "lastActivityAt" | "state">
>;

const freeze = (session: EngineSession): EngineSession => Object.freeze({ ...session });

export class SessionRegistry {
  readonly #sessions = new Map<string, EngineSession>();
  readonly #clock: () => number;

  constructor(options?: SessionRegistryOptions) {
    this.#clock = options?.clock ?? Date.now;
  }

  /** Insert a new session; a duplicate sessionId is an allocation-path invariant break. */
  register(session: EngineSession): void {
    if (this.#sessions.has(session.sessionId)) {
      throw spawnFailed(new Error(`duplicate sessionId ${session.sessionId}`));
    }
    this.#sessions.set(session.sessionId, freeze(session));
  }

  get(sessionId: string): EngineSession | undefined {
    const session = this.#sessions.get(sessionId);
    return session ? freeze(session) : undefined;
  }

  /**
   * Tenant-scoped lookup: a session is invisible to every other organization
   * (§25 rule 4 — sessions are never shared across tenants). Returns `undefined`
   * both for unknown ids and cross-tenant probes.
   */
  findForTenant(sessionId: string, organizationId: string): EngineSession | undefined {
    const session = this.#sessions.get(sessionId);
    return session && session.organizationId === organizationId
      ? freeze(session)
      : undefined;
  }

  /** The active session bound to this tenant's document, most recently active first. */
  findByDocument(organizationId: string, documentId: string): EngineSession | undefined {
    let match: EngineSession | undefined;
    for (const session of this.#sessions.values()) {
      if (session.organizationId !== organizationId) continue;
      if (session.documentId !== documentId) continue;
      if (!ACTIVE_SESSION_STATES.includes(session.state)) continue;
      if (!match || session.lastActivityAt > match.lastActivityAt) match = session;
    }
    return match ? freeze(match) : undefined;
  }

  update(sessionId: string, patch: SessionPatch): EngineSession {
    const session = this.#sessions.get(sessionId);
    if (!session) throw sessionNotFound();
    const next = freeze({ ...session, ...patch });
    this.#sessions.set(sessionId, next);
    return freeze(next);
  }

  remove(sessionId: string): EngineSession | undefined {
    const session = this.#sessions.get(sessionId);
    this.#sessions.delete(sessionId);
    return session ? freeze(session) : undefined;
  }

  size(): number {
    return this.#sessions.size;
  }

  list(filter?: ListFilter): EngineSession[] {
    const sessions: EngineSession[] = [];
    for (const session of this.#sessions.values()) {
      if (filter?.organizationId !== undefined && session.organizationId !== filter.organizationId) {
        continue;
      }
      if (filter?.states !== undefined && !filter.states.includes(session.state)) continue;
      sessions.push(freeze(session));
    }
    return sessions;
  }

  /**
   * Sessions holding a real, usable process for this tenant — these consume the
   * per-organization concurrency cap (§3.2 plan limit). `draining` and `crashed`
   * never count: draining ones are exiting, and crashed sessions must not block
   * the tenant's recovery allocation (§3.4 crash recovery).
   */
  countActive(organizationId: string): number {
    let count = 0;
    for (const session of this.#sessions.values()) {
      if (
        session.organizationId === organizationId &&
        ACTIVE_SESSION_STATES.includes(session.state)
      ) {
        count += 1;
      }
    }
    return count;
  }

  /**
   * Idle-eviction candidates: active sessions whose last activity is at least
   * `maxIdleMs` ago, most-idle first (§3.2 idle timeout → checkpoint → recycle).
   */
  evictionCandidates(options?: EvictionOptions): EngineSession[] {
    const now = options?.now ?? this.#clock();
    const maxIdleMs = options?.maxIdleMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const candidates: EngineSession[] = [];
    for (const session of this.#sessions.values()) {
      if (!ACTIVE_SESSION_STATES.includes(session.state)) continue;
      if (now - session.lastActivityAt >= maxIdleMs) candidates.push(session);
    }
    candidates.sort((a, b) => a.lastActivityAt - b.lastActivityAt);
    return candidates.map((session) => freeze(session));
  }
}
