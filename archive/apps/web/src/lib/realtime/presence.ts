// apps/web/src/lib/realtime — presence client core (W8-R).
//
// Spec anchors: §3.1 `realtime` row ("Centrifugo (optional at start; SSE
// first)"), §16.2 (SSE fallback first), §19 Phase 3 ("Presence via Centrifugo
// (cursors optional), run sharing, workspace activity feed"), and §25 rule 3
// — NO collaborative painting / CRDT in v1: presence and notifications ONLY,
// the server stays authoritative. This module never carries document edits.
//
// v1 surface (kept deliberately small — §25-18 "no just-in-case
// abstractions"):
//   PresenceClient          — { subscribe(channel, cb), unsubscribe, destroy }
//   CentrifugoPresence      — websocket impl; `centrifuge` is loaded from a
//                             CDN via a guarded dynamic import (NO dependency
//                             is added to package.json); on failure the client
//                             degrades gracefully to the SSE poll impl.
//   SseFallbackPresence     — poll-based presence over the gateway heartbeat
//                             contract below (SSE-first per §3.1/§16.2).
//   createPresenceClient()  — mode auto-selection from env
//                             NEXT_PUBLIC_REALTIME=centrifugo|sse|off
//                             (default `sse` — SSE first).
//
// Presence channel naming: `documentPresenceChannel(documentId)` →
// `doc:<documentId>`. The Centrifugo server namespace `doc` must enable
// `join_leave` + `presence` (infra pointer: §3.1 realtime row — see
// components/realtime/README.md "Centrifugo configuration (infra)").
//
// ── Gateway endpoint contracts (TODO(gateway) — routes do not exist yet) ──
//
// The SSE fallback polls ONE endpoint (heartbeat + roster read in a single
// round trip; the roster is everyone whose heartbeat is inside the server TTL
// window — recommended TTL ≈ 2–3 × the client interval):
//
//   POST   /v1/documents/:id/presence/heartbeat
//     auth: session cookie · body: `{}` (empty JSON object)
//     headers: `Idempotency-Key: <one stable UUID per subscription session>`
//              (§13 convention; a replayed heartbeat must not corrupt the
//               ephemeral roster — the key is stable per channel session)
//     → 200 `{ ok: true, viewers: PresenceViewerDto[], ttl_ms?: number }`
//   DELETE /v1/documents/:id/presence/heartbeat
//     → 204 best-effort immediate leave; TTL expiry covers crashed tabs
//
//   PresenceViewerDto = `{ id: string, name?: string | null, self?: boolean }`
//   — `id` is the viewer's user id when known (else an anonymous session id);
//     `name` is the gateway's display-name join; `self` marks the CALLER.
//   The zod mirrors below are the pin the gateway routes must mirror
//   (§13 audit convention: zod at the boundary, mirrored in openapi.ts).
//
// Centrifugo connection credentials: v1 accepts a static dev `token` option;
// the durable contract is gateway-minted connection/subscription JWTs —
// TODO(gateway): `GET /v1/realtime/centrifugo/connection-token`.
//
// Hermetic by design (mirrors src/lib/api.ts): no module-scope env reads
// (lazy — first subscribe), `fetch` injectable, all external payloads
// zod-validated, and no `any` in exported APIs.

import { z } from "zod";
import { ClientEnvError, getClientEnv, type EnvSource } from "../env";
import type { FetchLike } from "../api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One viewer on a channel. `id` = user id when known, else session id. */
export interface PresenceMember {
  readonly id: string;
  /** Display name when the server could resolve one; rendered via initials. */
  readonly name: string | null;
  /** True when this entry is the current user (marker: "you"). */
  readonly self: boolean;
}

/** What changed in one roster update. `sync` = snapshot/refresh, no toast. */
export type PresenceDelta =
  | { readonly type: "sync" }
  | { readonly type: "join"; readonly member: PresenceMember }
  | { readonly type: "leave"; readonly member: PresenceMember };

export interface PresenceUpdate {
  readonly channel: string;
  /** Full roster after the delta — consumers never keep their own diff. */
  readonly roster: readonly PresenceMember[];
  readonly delta: PresenceDelta;
}

export type PresenceState =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error"
  | "disabled";

export type PresenceTransport = "centrifugo" | "sse" | "none";

/** User-safe status — never carries URLs, stack traces or internal ids. */
export interface PresenceStatus {
  readonly transport: PresenceTransport;
  readonly state: PresenceState;
  readonly detail: string | null;
}

export type PresenceListener = (update: PresenceUpdate) => void;

/**
 * The presence seam every UI consumer codes against (§19 Phase 3).
 * `subscribe` returns a disposer; `unsubscribe(channel, listener?)` is the
 * symmetric removal (no listener = drop the whole channel).
 */
export interface PresenceClient {
  subscribe(channel: string, listener: PresenceListener): () => void;
  unsubscribe(channel: string, listener?: PresenceListener): void;
  /** Releases every channel AND the underlying transport (websocket/polls). */
  destroy(): void;
}

export type PresenceStatusHandler = (status: PresenceStatus) => void;

export type RealtimeMode = "centrifugo" | "sse" | "off";

/** The lazy env-source contract this module reads (re-export for consumers). */
export type { EnvSource } from "../env";

/** Typed env error (mirrors ClientEnvError): names the offending variables. */
export class RealtimeEnvError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `apps/web: invalid realtime environment — ${problems.join("; ")}. ` +
        "Check NEXT_PUBLIC_REALTIME / NEXT_PUBLIC_CENTRIFUGO_URL in .env.",
    );
    this.name = "RealtimeEnvError";
    this.problems = problems;
  }
}

/** Internal typed error for transport wiring failures (never leaked raw). */
export class RealtimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RealtimeError";
  }
}

// ---------------------------------------------------------------------------
// Env parsing (lazy — never at module scope, keeps prerender builds green)
// ---------------------------------------------------------------------------

const realtimeModeSchema = z.enum(["centrifugo", "sse", "off"]);

/**
 * NEXT_PUBLIC_REALTIME selector. Unset/empty → `sse` (§3.1 "SSE first",
 * §16.2); a typo fails fast with a typed RealtimeEnvError — an optional
 * presence flag must never silently disable itself (§4 refuse-on-bad-env).
 */
export function parseRealtimeMode(source: EnvSource): RealtimeMode {
  const raw = source["NEXT_PUBLIC_REALTIME"];
  if (raw === undefined || raw === "") {
    return "sse";
  }
  const parsed = realtimeModeSchema.safeParse(raw.trim());
  if (!parsed.success) {
    throw new RealtimeEnvError([
      `NEXT_PUBLIC_REALTIME: expected centrifugo|sse|off, got "${raw}"`,
    ]);
  }
  return parsed.data;
}

const centrifugoUrlSchema = z
  .string()
  .refine((value) => /^(wss?|https?):\/\//.test(value), "must be a ws(s):// or http(s):// URL");

/**
 * NEXT_PUBLIC_CENTRIFUGO_URL — optional (Centrifugo is "optional at start",
 * §3.1). Unset → null (caller falls back to the SSE impl); a present-but-bad
 * value throws RealtimeEnvError.
 */
export function parseCentrifugoUrl(source: EnvSource): string | null {
  const raw = source["NEXT_PUBLIC_CENTRIFUGO_URL"];
  if (raw === undefined || raw === "") {
    return null;
  }
  const parsed = centrifugoUrlSchema.safeParse(raw.trim());
  if (!parsed.success) {
    throw new RealtimeEnvError([
      `NEXT_PUBLIC_CENTRIFUGO_URL: ${parsed.error.issues[0]?.message ?? "invalid URL"}`,
    ]);
  }
  return parsed.data.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Channel naming
// ---------------------------------------------------------------------------

/** Presence channel for one document (Centrifugo namespace `doc`). */
export function documentPresenceChannel(documentId: string): string {
  return `doc:${documentId}`;
}

/**
 * Inverse of `documentPresenceChannel` (lenient: a bare id is accepted so
 * callers can pass either shape). Feeds the SSE impl's `:documentId` path.
 */
export function documentIdFromPresenceChannel(channel: string): string {
  return channel.startsWith("doc:") ? channel.slice("doc:".length) : channel;
}

// ---------------------------------------------------------------------------
// Pure helpers (presence domain)
// ---------------------------------------------------------------------------

/** "Ada Lovelace"→"AL", "jean-paul sartre"→"JS", ""/null→"?" (≤2 chars). */
export function initialsOf(name: string | null | undefined): string {
  if (name === null || name === undefined || name.trim() === "") {
    return "?";
  }
  const parts = name.trim().split(/\s+/).filter((part) => part !== "");
  const first = parts[0]?.charAt(0) ?? "";
  const second = parts.length > 1 ? (parts[1]?.charAt(0) ?? "") : "";
  const joined = `${first}${second}`.toUpperCase();
  return joined === "" ? "?" : joined.slice(0, 2);
}

export interface RosterDiff {
  readonly joins: readonly PresenceMember[];
  readonly leaves: readonly PresenceMember[];
}

/**
 * Set-diff of two rosters by member id (first occurrence wins — rosters may
 * contain the same user twice when a user holds two connections). A user
 * leaving one of two connections is NOT a leave (id still present).
 */
export function diffMembers(
  previous: readonly PresenceMember[],
  next: readonly PresenceMember[],
): RosterDiff {
  const prevById = new Map<string, PresenceMember>();
  for (const member of previous) {
    if (!prevById.has(member.id)) {
      prevById.set(member.id, member);
    }
  }
  const nextById = new Map<string, PresenceMember>();
  for (const member of next) {
    if (!nextById.has(member.id)) {
      nextById.set(member.id, member);
    }
  }
  const joins: PresenceMember[] = [];
  for (const member of nextById.values()) {
    if (!prevById.has(member.id)) {
      joins.push(member);
    }
  }
  const leaves: PresenceMember[] = [];
  for (const member of prevById.values()) {
    if (!nextById.has(member.id)) {
      leaves.push(member);
    }
  }
  return { joins, leaves };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Wire schemas (the boundary — gateway routes must mirror these)
// ---------------------------------------------------------------------------

/** One roster entry on the heartbeat wire (contract in the file header). */
export const presenceViewerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120).nullable().optional(),
  self: z.boolean().optional(),
});

export type PresenceViewerDto = z.infer<typeof presenceViewerSchema>;

/** `POST /v1/documents/:id/presence/heartbeat` success body. */
export const presenceHeartbeatResponseSchema = z.object({
  ok: z.literal(true),
  viewers: z.array(presenceViewerSchema).max(200),
  ttl_ms: z.number().int().positive().optional(),
});

// ---------------------------------------------------------------------------
// Centrifugo payload parsing (structural mirror of centrifuge-js v4 wire)
// ---------------------------------------------------------------------------

/**
 * Minimal structural mirror of the `centrifuge` client (v4). The package is
 * NOT a dependency — it is loaded from a CDN (see CENTRIFUGE_CDN_URL); these
 * local types keep the surface we rely on pinned and testable via fakes.
 */
export interface CentrifugeSubscriptionLike {
  on(event: string, handler: (ctx: unknown) => void): CentrifugeSubscriptionLike;
  subscribe(): void;
  unsubscribe(): void;
  /** RPC: current channel presence; shape lenient (see unwrapPresenceResult). */
  presence(): Promise<unknown>;
}

export interface CentrifugeLike {
  on(event: string, handler: (ctx: unknown) => void): CentrifugeLike;
  connect(): void;
  disconnect(): void;
  newSubscription(channel: string, options?: Record<string, unknown>): CentrifugeSubscriptionLike;
}

export type CentrifugeCtor = new (
  url: string,
  options?: Record<string, unknown>,
) => CentrifugeLike;

export type CentrifugeLoader = () => Promise<CentrifugeCtor>;

const channelInfoSchema = z.object({ name: z.string().min(1).max(120).optional() });

const centrifugoInfoSchema = z.object({
  client: z.string().min(1),
  user: z.string().min(1).optional(),
  conn_info: z.unknown().optional(),
  channel_info: z.unknown().optional(),
});

function memberFromInfo(
  info: {
    client: string;
    user?: string | undefined;
    channel_info?: unknown;
  },
  selfId: string | null,
): PresenceMember {
  const nameResult = channelInfoSchema.safeParse(info.channel_info);
  const name = nameResult.success ? (nameResult.data.name ?? null) : null;
  const id = info.user ?? info.client;
  return { id, name, self: selfId !== null && selfId === id };
}

/**
 * Map one Centrifugo presence/join/leave `info` payload (v4: client, user,
 * conn_info, channel_info) to a PresenceMember. Malformed entries → null
 * (never wedge presence on a drifting payload — same stance as api.ts).
 */
export function parsePresenceInfo(
  info: unknown,
  selfId: string | null = null,
): PresenceMember | null {
  const parsed = centrifugoInfoSchema.safeParse(info);
  if (!parsed.success) {
    return null;
  }
  return memberFromInfo(parsed.data, selfId);
}

/**
 * Join/leave event context is `{ info }` in centrifuge-js v4; tolerate the
 * bare info object too. Returns the roster key (connection id) + member.
 */
export function parseJoinLeaveContext(
  ctx: unknown,
  selfId: string | null = null,
): { key: string; member: PresenceMember } | null {
  const infoCandidate = isRecord(ctx) && "info" in ctx ? ctx["info"] : ctx;
  const parsed = centrifugoInfoSchema.safeParse(infoCandidate);
  if (!parsed.success) {
    return null;
  }
  return { key: parsed.data.client, member: memberFromInfo(parsed.data, selfId) };
}

/**
 * Tolerant walk of a `presence()` RPC result. v4 resolves
 * `{ presence: { [client]: info } }`; accept the bare map as well and skip
 * entries that fail the info schema.
 */
export function unwrapPresenceResult(
  raw: unknown,
  selfId: string | null = null,
): readonly { key: string; member: PresenceMember }[] {
  const map =
    isRecord(raw) && isRecord(raw["presence"]) ? raw["presence"] : isRecord(raw) ? raw : null;
  if (map === null) {
    return [];
  }
  const entries: { key: string; member: PresenceMember }[] = [];
  for (const [key, info] of Object.entries(map)) {
    const member = parsePresenceInfo(info, selfId);
    if (member !== null) {
      entries.push({ key, member });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Roster bookkeeping (internal — one per channel)
// ---------------------------------------------------------------------------

interface RosterEntry {
  readonly key: string;
  readonly member: PresenceMember;
}

/**
 * Per-channel roster state machine. The impl owns the opaque `key`
 * (Centrifugo: connection id; SSE: viewer id) so a user's second connection
 * never aliases their first. Deltas are derived by member id (diffMembers).
 */
class ChannelRoster {
  private readonly byKey = new Map<string, PresenceMember>();
  private seenSnapshot = false;

  constructor(private readonly channel: string) {}

  join(entry: RosterEntry): PresenceUpdate {
    this.byKey.set(entry.key, entry.member);
    return {
      channel: this.channel,
      roster: this.list(),
      delta: { type: "join", member: entry.member },
    };
  }

  leave(key: string): PresenceUpdate | null {
    const member = this.byKey.get(key);
    if (member === undefined) {
      return null;
    }
    this.byKey.delete(key);
    return {
      channel: this.channel,
      roster: this.list(),
      delta: { type: "leave", member },
    };
  }

  /**
   * Wholesale replace (heartbeat roster / presence() refresh). The FIRST
   * snapshot is a pure `sync` — people who were already viewing must not
   * fire "joined" toasts (§19: presence, not noise). Later replaces diff by
   * member id and emit one update per join/leave delta + a terminal `sync`.
   */
  replace(entries: readonly RosterEntry[]): readonly PresenceUpdate[] {
    const before = this.list();
    const after: PresenceMember[] = [];
    for (const entry of entries) {
      after.push(entry.member);
    }
    const diff = this.seenSnapshot ? diffMembers(before, after) : { joins: [], leaves: [] };
    const updates: PresenceUpdate[] = [];
    for (const member of diff.leaves) {
      updates.push({
        channel: this.channel,
        roster: before.filter((candidate) => candidate.id !== member.id),
        delta: { type: "leave", member },
      });
    }
    this.byKey.clear();
    for (const entry of entries) {
      this.byKey.set(entry.key, entry.member);
    }
    const roster = this.list();
    for (const member of diff.joins) {
      updates.push({
        channel: this.channel,
        roster,
        delta: { type: "join", member },
      });
    }
    updates.push({ channel: this.channel, roster, delta: { type: "sync" } });
    this.seenSnapshot = true;
    return updates;
  }

  list(): readonly PresenceMember[] {
    return [...this.byKey.values()];
  }
}

// ---------------------------------------------------------------------------
// NoopPresenceClient — mode "off" (realtime disabled for this deployment)
// ---------------------------------------------------------------------------

export interface NoopPresenceOptions {
  readonly onStatus?: PresenceStatusHandler;
}

export class NoopPresenceClient implements PresenceClient {
  private readonly onStatus: NoopPresenceOptions["onStatus"];

  constructor(options: NoopPresenceOptions = {}) {
    this.onStatus = options.onStatus;
    this.onStatus?.({ transport: "none", state: "disabled", detail: null });
  }

  subscribe(): () => void {
    return () => {};
  }

  unsubscribe(): void {}

  destroy(): void {}
}

// ---------------------------------------------------------------------------
// SseFallbackPresence — poll-based presence (§3.1 "SSE first")
// ---------------------------------------------------------------------------

export interface SseFallbackPresenceOptions {
  /** Gateway base INCLUDING `/v1`; omit for lazy NEXT_PUBLIC_API_BASE_URL. */
  readonly baseUrl?: string;
  /** Injectable fetch (tests pass a fake; production uses the global). */
  readonly fetch?: FetchLike;
  /** Current user's id — marks the "you" entry when the server didn't. */
  readonly selfId?: string | null;
  /** Heartbeat interval (default 10 s; floor 1 s). Server TTL ≈ 2–3× this. */
  readonly intervalMs?: number;
  readonly onStatus?: PresenceStatusHandler;
}

interface SseChannel {
  readonly documentId: string;
  readonly listeners: Set<PresenceListener>;
  readonly roster: ChannelRoster;
  /** One stable UUID per channel session (§13 Idempotency-Key). */
  readonly heartbeatKey: string;
  timer: ReturnType<typeof setInterval> | null;
  inFlight: boolean;
}

const SSE_DEFAULT_INTERVAL_MS = 10_000;
const SSE_MIN_INTERVAL_MS = 1_000;

const SSE_STATUS_DETAIL: Record<PresenceState, string | null> = {
  connecting: null,
  connected: null,
  disconnected: "Presence updates are paused — retrying.",
  error: "Presence is unavailable right now.",
  disabled: null,
};

export class SseFallbackPresence implements PresenceClient {
  private readonly baseUrlOption: string | undefined;
  private readonly fetchFn: FetchLike;
  private readonly selfId: string | null;
  private readonly intervalMs: number;
  private readonly onStatus: SseFallbackPresenceOptions["onStatus"];
  private readonly channels = new Map<string, SseChannel>();
  private state: PresenceState = "disconnected";

  constructor(options: SseFallbackPresenceOptions = {}) {
    this.baseUrlOption = options.baseUrl;
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.selfId = options.selfId ?? null;
    this.intervalMs = Math.max(options.intervalMs ?? SSE_DEFAULT_INTERVAL_MS, SSE_MIN_INTERVAL_MS);
    this.onStatus = options.onStatus;
  }

  subscribe(channel: string, listener: PresenceListener): () => void {
    let state = this.channels.get(channel);
    if (state === undefined) {
      state = {
        documentId: documentIdFromPresenceChannel(channel),
        listeners: new Set(),
        roster: new ChannelRoster(channel),
        heartbeatKey: crypto.randomUUID(),
        timer: null,
        inFlight: false,
      };
      this.channels.set(channel, state);
    }
    state.listeners.add(listener);
    if (state.timer === null) {
      this.setStatus("connecting");
      void this.pump(state);
      state.timer = setInterval(() => void this.pump(state), this.intervalMs);
    }
    return () => this.unsubscribe(channel, listener);
  }

  unsubscribe(channel: string, listener?: PresenceListener): void {
    const state = this.channels.get(channel);
    if (state === undefined) {
      return;
    }
    if (listener === undefined) {
      state.listeners.clear();
    } else {
      state.listeners.delete(listener);
    }
    if (state.listeners.size === 0) {
      this.closeChannel(channel, state);
    }
  }

  destroy(): void {
    for (const [channel, state] of [...this.channels]) {
      this.closeChannel(channel, state);
    }
  }

  private closeChannel(channel: string, state: SseChannel): void {
    if (state.timer !== null) {
      clearInterval(state.timer);
      state.timer = null;
    }
    this.channels.delete(channel);
    // Best-effort immediate leave; TTL expiry covers crashed tabs.
    void this.leaveQuietly(state.documentId);
  }

  private resolveBaseUrl(): string {
    return this.baseUrlOption ?? getClientEnv().apiBaseUrl;
  }

  private async pump(state: SseChannel): Promise<void> {
    if (state.inFlight) {
      return;
    }
    state.inFlight = true;
    try {
      const base = this.resolveBaseUrl();
      const response = await this.fetchFn(
        `${base}/documents/${encodeURIComponent(state.documentId)}/presence/heartbeat`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "Idempotency-Key": state.heartbeatKey,
          },
          body: JSON.stringify({}),
          credentials: "include",
        },
      );
      if (!response.ok) {
        this.setStatus(
          response.status === 401 || response.status === 403 ? "error" : "disconnected",
        );
        return;
      }
      const body: unknown = await response.json().catch(() => null);
      const parsed = presenceHeartbeatResponseSchema.safeParse(body);
      if (!parsed.success) {
        this.setStatus("disconnected");
        return;
      }
      const entries: RosterEntry[] = parsed.data.viewers.map((viewer) => ({
        key: viewer.id,
        member: {
          id: viewer.id,
          name: viewer.name ?? null,
          self: viewer.self === true || (this.selfId !== null && this.selfId === viewer.id),
        },
      }));
      this.emitAll(state, state.roster.replace(entries));
      this.setStatus("connected");
    } catch (error) {
      if (error instanceof ClientEnvError || error instanceof RealtimeEnvError) {
        this.setStatus("error");
      } else {
        this.setStatus("disconnected");
      }
    } finally {
      state.inFlight = false;
    }
  }

  private leaveQuietly(documentId: string): Promise<void> {
    const send = async (): Promise<void> => {
      try {
        await this.fetchFn(
          `${this.resolveBaseUrl()}/documents/${encodeURIComponent(documentId)}/presence/heartbeat`,
          { method: "DELETE", credentials: "include", keepalive: true },
        );
      } catch {
        // Best-effort by contract; the server TTL is the source of truth.
      }
    };
    return send();
  }

  private emitAll(state: SseChannel, updates: readonly PresenceUpdate[]): void {
    for (const update of updates) {
      for (const listener of [...state.listeners]) {
        listener(update);
      }
    }
  }

  private setStatus(state: PresenceState): void {
    if (this.state === state) {
      return;
    }
    this.state = state;
    this.onStatus?.({ transport: "sse", state, detail: SSE_STATUS_DETAIL[state] });
  }
}

// ---------------------------------------------------------------------------
// CentrifugoPresence — CDN-loaded websocket impl (§19 Phase 3)
// ---------------------------------------------------------------------------

/**
 * centrifuge-js v4 browser build, ESM-wrapped by jsDelivr. Pinned to the v4
 * major (infra wave bumps deliberately — README "Centrifugo configuration").
 * `centrifuge` is MIT-licensed; NO package.json dependency is added.
 */
export const CENTRIFUGE_CDN_URL = "https://cdn.jsdelivr.net/npm/centrifuge@4/+esm";

function pickCentrifugeCtor(module: unknown): unknown {
  if (!isRecord(module)) {
    return undefined;
  }
  const named = module["Centrifuge"];
  if (typeof named === "function") {
    return named;
  }
  const def = module["default"];
  if (isRecord(def) && typeof def["Centrifuge"] === "function") {
    return def["Centrifuge"];
  }
  if (typeof def === "function") {
    return def;
  }
  return undefined;
}

/**
 * Guarded CDN dynamic import. The ignore-comments keep webpack/turbopack
 * from trying to bundle a remote URL into the build; failure (offline,
 * blocked CDN, CSP) resolves to a rejection caught by the caller — the
 * client then degrades to the SSE fallback (graceful, never throws up).
 */
export const defaultCentrifugeLoader =
  (cdnUrl: string = CENTRIFUGE_CDN_URL): CentrifugeLoader =>
  async () => {
    const url = cdnUrl; // variable — bundlers must not inline the specifier
    const module = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url)) as unknown;
    const ctor = pickCentrifugeCtor(module);
    if (typeof ctor !== "function") {
      throw new RealtimeError("The realtime client script could not be loaded.");
    }
    return ctor as CentrifugeCtor;
  };

export interface CentrifugoPresenceOptions {
  /** Centrifugo endpoint, e.g. wss://realtime.example.com/connection/websocket. */
  readonly url: string;
  /** Override the CDN module URL (default CENTRIFUGE_CDN_URL). */
  readonly cdnUrl?: string;
  /**
   * Static connection token (dev). Durable contract: gateway-minted JWTs
   * (TODO(gateway) — see file header) — a static token keeps local dev
   * tokenless until that route lands.
   */
  readonly token?: string;
  readonly selfId?: string | null;
  /** Injectable loader (tests pass a fake; default = the CDN import). */
  readonly loader?: CentrifugeLoader;
  /** Graceful-degradation target (the factory wires the SSE poll client). */
  readonly fallback?: () => PresenceClient;
  readonly onStatus?: PresenceStatusHandler;
}

interface CentrifugoChannel {
  readonly channel: string;
  readonly listeners: Set<PresenceListener>;
  readonly roster: ChannelRoster;
  sub: CentrifugeSubscriptionLike | null;
}

type CentrifugoLifecycle = "idle" | "starting" | "live" | "degraded";

export class CentrifugoPresence implements PresenceClient {
  private readonly options: CentrifugoPresenceOptions;
  private readonly channels = new Map<string, CentrifugoChannel>();
  private lifecycle: CentrifugoLifecycle = "idle";
  private startPromise: Promise<void> | null = null;
  private centrifuge: CentrifugeLike | null = null;
  private fallbackClient: PresenceClient | null = null;
  private destroyed = false;

  constructor(options: CentrifugoPresenceOptions) {
    this.options = options;
  }

  subscribe(channel: string, listener: PresenceListener): () => void {
    if (this.fallbackClient !== null) {
      return this.fallbackClient.subscribe(channel, listener);
    }
    const state = this.ensureChannel(channel);
    state.listeners.add(listener);
    if (this.lifecycle === "live") {
      this.attach(state);
    } else {
      void this.ensureStarted();
    }
    return () => this.unsubscribe(channel, listener);
  }

  unsubscribe(channel: string, listener?: PresenceListener): void {
    if (this.fallbackClient !== null) {
      this.fallbackClient.unsubscribe(channel, listener);
      return;
    }
    const state = this.channels.get(channel);
    if (state === undefined) {
      return;
    }
    if (listener === undefined) {
      state.listeners.clear();
    } else {
      state.listeners.delete(listener);
    }
    if (state.listeners.size === 0) {
      state.sub?.unsubscribe();
      this.channels.delete(channel);
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.fallbackClient !== null) {
      this.fallbackClient.destroy();
      return;
    }
    for (const state of [...this.channels.values()]) {
      state.sub?.unsubscribe();
    }
    this.channels.clear();
    this.centrifuge?.disconnect();
    this.centrifuge = null;
  }

  private ensureChannel(channel: string): CentrifugoChannel {
    let state = this.channels.get(channel);
    if (state === undefined) {
      state = { channel, listeners: new Set(), roster: new ChannelRoster(channel), sub: null };
      this.channels.set(channel, state);
    }
    return state;
  }

  private async ensureStarted(): Promise<void> {
    if (this.lifecycle === "live" || this.lifecycle === "degraded") {
      return;
    }
    if (this.startPromise === null) {
      this.startPromise = this.start();
    }
    await this.startPromise;
    this.startPromise = null;
  }

  private async start(): Promise<void> {
    this.lifecycle = "starting";
    this.report("connecting", null);
    try {
      const load = this.options.loader ?? defaultCentrifugeLoader(this.options.cdnUrl);
      const ctor = await load();
      if (this.destroyed) {
        return;
      }
      const options: Record<string, unknown> = {};
      if (this.options.token !== undefined) {
        options["token"] = this.options.token;
      }
      const centrifuge = new ctor(this.options.url, options);
      centrifuge.on("connect", () => {
        this.report("connected", null);
      });
      centrifuge.on("disconnect", () => {
        if (this.lifecycle === "live") {
          this.report("disconnected", "Realtime connection dropped — reconnecting.");
        }
      });
      centrifuge.connect();
      this.centrifuge = centrifuge;
      this.lifecycle = "live";
      for (const state of this.channels.values()) {
        this.attach(state);
      }
    } catch {
      this.degrade();
    }
  }

  /**
   * Graceful fallback (the guarded CDN import failed or the transport threw):
   * hand every recorded channel to the fallback client and proxy future
   * subscriptions. No fallback factory → inert client + error status.
   */
  private degrade(): void {
    this.lifecycle = "degraded";
    const factory = this.options.fallback;
    if (factory === undefined) {
      this.report("error", "Realtime presence is unavailable right now.");
      return;
    }
    const fallback = factory();
    this.fallbackClient = fallback;
    const moved = [...this.channels.values()];
    this.channels.clear();
    this.centrifuge?.disconnect();
    this.centrifuge = null;
    for (const state of moved) {
      for (const listener of [...state.listeners]) {
        fallback.subscribe(state.channel, listener);
      }
    }
    this.report("error", "Realtime connection failed — using the polling fallback.");
  }

  private attach(state: CentrifugoChannel): void {
    if (this.centrifuge === null || state.sub !== null) {
      return;
    }
    const sub = this.centrifuge.newSubscription(state.channel, {});
    state.sub = sub;
    const selfId = this.options.selfId ?? null;
    sub.on("join", (ctx) => {
      const entry = parseJoinLeaveContext(ctx, selfId);
      if (entry !== null) {
        this.emit(state, state.roster.join(entry));
      }
    });
    sub.on("leave", (ctx) => {
      const entry = parseJoinLeaveContext(ctx, selfId);
      if (entry !== null) {
        const update = state.roster.leave(entry.key);
        if (update !== null) {
          this.emit(state, update);
        }
      }
    });
    sub.on("subscribed", () => {
      void this.refresh(state, sub);
    });
    sub.subscribe();
  }

  private async refresh(state: CentrifugoChannel, sub: CentrifugeSubscriptionLike): Promise<void> {
    try {
      const raw = await sub.presence();
      if (this.destroyed) {
        return;
      }
      const entries = unwrapPresenceResult(raw, this.options.selfId ?? null);
      this.emitAll(state, state.roster.replace(entries));
    } catch {
      // presence RPC unavailable (namespace config) — join/leave events
      // still drive the roster; stay silent (infra pointer in README).
    }
  }

  private emit(state: CentrifugoChannel, update: PresenceUpdate): void {
    this.emitAll(state, [update]);
  }

  private emitAll(state: CentrifugoChannel, updates: readonly PresenceUpdate[]): void {
    for (const update of updates) {
      for (const listener of [...state.listeners]) {
        listener(update);
      }
    }
  }

  private report(state: PresenceState, detail: string | null): void {
    this.options.onStatus?.({ transport: "centrifugo", state, detail });
  }
}

// ---------------------------------------------------------------------------
// Factory — mode auto-selection (NEXT_PUBLIC_REALTIME)
// ---------------------------------------------------------------------------

export interface PresenceClientOptions {
  /** Override the env-derived mode (tests); default = parseRealtimeMode. */
  readonly mode?: RealtimeMode;
  /** Env source (tests inject a record); default = process.env, read LAZILY. */
  readonly source?: EnvSource;
  readonly fetch?: FetchLike;
  /** Gateway base INCLUDING `/v1`; default = NEXT_PUBLIC_API_BASE_URL (lazy). */
  readonly baseUrl?: string;
  readonly intervalMs?: number;
  readonly selfId?: string | null;
  readonly onStatus?: PresenceStatusHandler;
}

/**
 * The one constructor UI code should call (use-presence.ts uses it; direct
 * callers too). Selection:
 *   "off"         → NoopPresenceClient (realtime disabled)
 *   "sse"         → SseFallbackPresence (§3.1 "SSE first" — the default)
 *   "centrifugo"  → CentrifugoPresence when NEXT_PUBLIC_CENTRIFUGO_URL is
 *                   set, else the SSE poll client (config-level fallback);
 *                   CDN/connect failures at runtime degrade to SSE too.
 */
export function createPresenceClient(options: PresenceClientOptions = {}): PresenceClient {
  const source = options.source ?? process.env;
  const mode = options.mode ?? parseRealtimeMode(source);
  const sseOptions: SseFallbackPresenceOptions = {
    baseUrl: options.baseUrl,
    fetch: options.fetch,
    selfId: options.selfId,
    intervalMs: options.intervalMs,
    onStatus: options.onStatus,
  };
  if (mode === "off") {
    return new NoopPresenceClient({ onStatus: options.onStatus });
  }
  if (mode === "sse") {
    return new SseFallbackPresence(sseOptions);
  }
  const url = parseCentrifugoUrl(source);
  if (url === null) {
    // No Centrifugo endpoint configured — SSE poll client stands in (§3.1).
    return new SseFallbackPresence(sseOptions);
  }
  return new CentrifugoPresence({
    url,
    cdnUrl: CENTRIFUGE_CDN_URL,
    selfId: options.selfId,
    onStatus: options.onStatus,
    fallback: () =>
      new SseFallbackPresence({
        ...sseOptions,
        // The fallback reports its own transport ("sse"); the outer
        // onStatus still fires once more with the degradation reason.
        onStatus: (status) => options.onStatus?.(status),
      }),
  });
}
