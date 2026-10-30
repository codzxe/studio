# Worklog (restarted 2026-10-30 — full history: archive/2026-10-30/worklog-through-2026-10-30.md)

Next entry:

## 2026-10-30 (later) — audit follow-up wave 2: nine deferred fixes landed

Context: the 2026-10-30 deep audit (AUDIT.md) shipped 14 fixes + the restructure but left a
follow-up ledger. This wave lands the code-actionable remainder, each gated by the repo's
own suites. Baseline before the wave: gateway 1,133 · web 1,725 · worker 57 (sqlite dialect).

- **SEC-03 (HIGH) — API-key scopes are now ENFORCED.** `requireAuth` resolves the key row by
  the apiKey plugin's session-mock id (`session.id = apiKey.id`), derives wire scopes from the
  stored statements, and applies a route-by-route capability table
  (`apiKeyRouteAccess`: any-key introspection / scope-gated data plane / cookie-only admin +
  money + share minting; unmapped routes fail closed). Bonus hardening beyond the sketch: the
  key's `metadata.workspaceId` binding is enforced in `resolveWorkspaceContext` (§12.1 404 —
  a leaked key stays inside one workspace even within its minting user's own orgs), and
  billing GETs moved from blanket-blocked to the `billing:read` scope the UI sells.
  Tests: `tests/api-key-scopes.test.ts` (rule table pinned route-by-route + middleware
  through the app) and five real-plugin flows in `tests/api-keys.test.ts`. Fixed a latent
  hole found mid-implementation: a `*` key stores the FULL statement map, which
  `apiKeyStatementsToScopes` normalizes to `["*"]` — the grant check now accepts `*`.
- **SEC-11 (LOW) — `countPendingInvites` fails CLOSED.** Auth transport failures, non-OK
  answers, malformed bodies and non-array bodies now render a typed retryable 503
  SERVICE_UNAVAILABLE (the invite/checkout mutation is refused) instead of counting 0
  pending and admitting invites past the paid seat limit. The old fail-open pin was
  inverted into two fail-closed pins.
- **SEC-05 (partial, MED) — IPv6 /64 normalization.** `clientIp` normalizes every IPv6
  rate-limit key to its /64 prefix (one ISP delegation = one bucket — host-bit cycling can
  no longer mint fresh limiter buckets against the scrypt share gate and every
  (ip, route-class) limit). IPv4, IPv4-mapped and junk pass through untouched. Valkey
  backend + identity keys remain follow-ups (PERF-09).
- **BIL-06 (partial, MED) — render frame-rate cap + per-job frame ceiling.**
  `RENDER_SETTINGS_SCHEMA.frameRate` is 1..240; the gateway clamps the EFFECTIVE rate
  (comp-native fps included — attacker-controlled project metadata) into the same bound
  before pricing, and refuses `ceil(seconds × fps) > MAX_RENDER_FRAMES (1.5M)` typed at
  queue AND estimate time; the worker re-clamps and re-guards at spawn (legacy rows).
  Frame-based pricing/attempt budgets remain product decisions.
- **BIL-04 (HIGH) — the card-required trial works with REAL Stripe.** Real Stripe never
  carries `cardFingerprint` metadata (that was the fake harness's model), so
  `POST /v1/billing/trial` 400'd for every production customer. New seam member
  `checkoutSessionCardFingerprint` resolves the card from the completed Checkout session's
  payment chain (direct PM, or payment intent → latest charge → PM → card fingerprint);
  `recordCustomer` persists it on checkout completion. Metadata (fake) still wins.
- **BIL-07 (MED) — DB CHECK constraints on the money table.** Migration `0009` +
  sqlite twin: kind vocabulary, per-kind signs (grant>0, refund>0, reserve<0, commit≤0,
  adjust ±), ±1e15 µc ceiling (SEC-10, now structural). `balance_after` deliberately NOT
  floored (BIL-08 posture: uncapped settles may go negative — a floor would 500 that path).
  The full gateway suite re-ran against a fresh constrained sqlite DB — every legit writer
  shape passes; `tests/sqlite/ledger-constraints.test.ts` pins the rejections.
- **PERF-03 (HIGH) — worker sha-keyed asset cache.** Assets are immutable +
  content-addressed, so hydration now goes through `.local/asset-cache/<sha256>` (atomic
  temp+rename publish; cache-write failures never fail a render) and fetches in
  bounded-parallel groups of 4. A warm 50-asset render goes from 50 sequential object-store
  round trips to zero.
- **SEC-01 recurrence gate — CI `gateway-bundle-drift` job.** Rebuilds the committed
  `apps/web/api/gateway.mjs` (`pnpm --filter @studio/web bundle:gateway`, extracted from
  the build script), fails on `git diff --exit-code`, then boots the rebuilt bundle through
  `scripts/gateway-bundle-smoke.mjs` (which now self-links its sqlite-twin peers so it runs
  from a fresh clone). The bundle itself was REBUILT and smoke-verified with this wave's
  gateway changes inside.
- **ENG-02 (HIGH) — expression wall-clock budget runs on the web.**
  `crates/expr`: `std::time::Instant` → `web_time::Instant` (1.1.0, already in the lock via
  boa; zero-cost std re-export on native). The `false`-on-wasm arm is gone — a crafted
  expression can no longer freeze the tab for minutes. No Rust toolchain in this sandbox:
  CI's `editor-cargo` job is the compile gate.

Verification: typecheck 10/10 · gateway 1,164 (+31) · web 1,725 · worker 62 (+5) · db 175
(+7) · contracts 273 (+1) — 3,399 green on the sqlite dialect (pg-only suites skip here,
CI runs them) · biome clean on every touched file · bundle rebuilt + smoke PASS.

Still open (product decisions, not code): BIL-08 negative-balance posture, PERF-10
retention, PERF-02 O(1) balance (needs a monotonic seq design), PERF-04 streaming zip,
PERF-07/09 request cache + Valkey, SEC-02 token rotation, ENG-01/03/04 engine work.
