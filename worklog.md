# Worklog (restarted 2026-10-30 — full history: archive/2026-10-30/worklog-through-2026-10-30.md)

Next entry:

## 2026-11-02 (round 14) — specific tools, continuous apply, receipts, salvage + auto-continue

Context: the deployed gateway ran the PRE-fix bundle (the committed
gateway.mjs is the runtime), so the user's Google-launch trace still showed
the exact failures round-13 fixed — plus three real round-14 bugs found by
reading the w8 live-apply path end to end. All suites green (contracts 285,
api-client 186, gateway 1204, web 1767); bundle rebuilt in the same commit.

- **Specific tools.** studio.create_solid (layer.newSolid + follow-up
  transform prop.set steps) and studio.create_camera (the curated
  layer.newCamera subset) replace the studio.engine_commands detour every
  real run took; the prompt narrows engine_commands to ops with no dedicated
  tool and forbids raw effect.* ids (the invented effect.add failure).
- **Continuous apply (the settle-order kill at the apply seam).**
  driveLiveApply's `resolutionRequests.length > 0 → continue` gate silently
  excluded EVERY carrier that references a layer by name — add_effect,
  set_keyframes, set_properties, apply_preset — so only creation tools ever
  applied during a run. The client apply engine resolves names against the
  LIVE project at apply time, and the chain runs after the earlier carriers
  of the same turn: a same-turn create_text → add_effect pair now lands both.
- **The remainder ledger.** liveAppliedCalls records exactly which carriers
  confirmed applied; finishRun merges ONLY the un-applied remainder into the
  run-end plan. The old full merge re-executed live-applied creates after a
  mid-run failure — duplicated compositions, the "it made everything twice"
  report.
- **Verification receipts.** every confirmed apply records
  "Applied: <summary> (saved <version>)"; the next turn POST carries
  applyReceipts and the gateway renders the APPLY RECEIPTS system note
  (extend it, never re-create it). Prompt: VERIFY AS YOU GO +
  CONTINUITY discipline (never re-create; resume the plan from its first
  incomplete step).
- **No more hard stops.** step cap 24→48, wall clock 10→15 min, turn wire
  64 parts/64 KB → 160 parts/192 KB. Step cap / wall clock now SALVAGE every
  un-applied carrier, fold a clean run.completed, and AUTO-CONTINUE the build
  with a bounded continuation run (MAX_AUTO_CONTINUATIONS=3) that inherits
  the full thread history + a fresh canvas. The repetition guard salvages
  but never continues (a broken loop would repeat in a fresh run).
- **Recovered the lost interpolation fix** (f1a9f4b — eased keyframe names
  with alias repair, keys.select/keys.interpolation) on top of the fresh
  0f7e3ec clone, and removed the committed probe scratch files.

## 2026-10-31 (round 13) — the harness feels like a harness: live thinking, fluid pacing, graceful stops, plan-first execution

Context: the user ran the agent against a real model and caught it red-handed — 20+ read-only
`describe_command` calls, zero writes, "no apply button", a frozen "Thinking…" string, a DbError
after every stop that raced a turn, and context amnesia after Stop. Round 12 (131d862, f62251b)
had already inlined the tool catalog, fixed `anim.builtinPresets`, made apply LIVE per turn,
unlimited context, and stop-remembered-steers. This round closes the remaining UX/discipline
gaps — five commits, each suite-gated, all verified END TO END in the browser against real GLM
through the new z-ai shim.

- **bdc77d4 — live thinking + fluid pacing.** The full reasoning pipeline now flows:
  openai.ts forwards the SDK's `reasoning-delta` parts (reasoning/reasoning_content, both
  field shapes) → executeModelTurn streams `onReasoningDelta` + returns the thinking text →
  the turn route emits `reasoning.delta` SSE frames live and stamps
  `turn.completed.reasoningText` (persisted, replay-restored). contracts gains the event
  (appended to the §7.4 catalogue); the web fold accumulates it with first-wins stamps; the
  new ReasoningBlock renders it Claude-style (open while thinking — live text, caret, pulsing
  dot, ticking clock; auto-collapsed to "Thought for Ns"; manual toggle wins) and upgrades
  the no-reasoning case to a LIVE elapsed indicator. The "stuck at one speed" root cause was
  upstream burst sizes (the z-ai seam hands over whole replies in 1-2 chunks): the new
  stream pacer buffers message+reasoning deltas and releases them at an adaptive 50ms-cadence
  (typing speed at the tail, fast-forward through bulk) with two safety contracts — non-delta
  events are never delayed (flush-before-forward, so the authoritative terminal replace can't
  race a stale tail) and every emitted event carries a strictly increasing rewritten seq.
  The pacer lives on the ActiveRun, survives a TURN_PAUSED resume (the dispose finally is
  guarded on finished/stopped — a parked run keeps its pacer), and dies with the run.
- **3d02cb2 — graceful run-state recovery.** A stop/abandon racing a turn hit
  `assertRunTransition` DbError CONFLICT in three places. Pre-stream heartbeat → the TYPED
  RUN_NOT_ACTIVE (409, retryable:false — the raw DbError envelope's retryable-undefined sent
  the transport into same-key re-POST loops → TURN_PAUSED noise). Post-model heartbeat →
  logged + skipped (the durable outcome + settle already landed; the terminal row stays
  terminal). Catch classification → TURN_CANCELLED (a cancellation, not INTERNAL "Something
  went wrong on our side."). Client: the run-end plan POST answered RUN_NOT_ACTIVE is
  swallowed — no more "The plan could not be submitted." after a stop.
- **b4db6df — execution discipline.** The prompt TOLD the model to explore (plan_edit as the
  way to "structure a larger change"; open-ended discovery). Now: "HOW TO WORK" — START
  BUILDING IMMEDIATELY (write calls in the first turn; at most ONE read before the first
  write; describe_command chains banned), PLAN FIRST as a numbered plan in the first reply,
  then ONE STEP PER TURN (the deep-research harness pattern — researched up front:
  Anthropic's long-running-agent harness + OpenAI-style deep research both converge on
  plan-once + incremental-checkpointed execution; our checkpoint IS the per-turn live apply
  + version save). plan_edit demoted to LAST RESORT. Golden pins updated (+ the old
  "Prefer one studio.plan_edit" lines asserted GONE).
- **41e4a00 — collapsible tool-calls bar.** ToolCallsBlock: the per-tool cards now sit under
  ONE collapsible bar — open while the run streams (header names the RUNNING call with a
  pulsing dot), folded to "Used N tool calls · X done · Y failed" when settled; manual toggle
  wins. TOOL_CARD_LABELS covers all 21 tools (write tools stopped rendering raw studio.* ids).
- **bd07abb — the z-ai shim + dev-ready storage pin.** scripts/dev/zai-shim.mjs: a local
  OpenAI-compatible GLM proxy (the SDK's stream yields raw OpenAI SSE frames as byte arrays —
  the shim is a pipe with framing repair; tool calls + multi-turn echo pass through; the SDK
  resolves from node_modules/bun-cache/ZAI_SDK_PATH, never a repo dep). dev-ready.mjs now pins
  STORAGE_FS_ROOT for the spawned gateway (e4610a6 parity — the gateway's cwd-relative
  default missed the seed blobs and the editor 404'd "The project could not open").

**Verified live in the browser (real GLM):** write tools in the FIRST turn; the numbered plan
opening the reply; 14 tool calls landing step by step; the canvas LIVE mid-run ("Comp: Studio
Intro" + "Selection: Studio Headline" read from engine state); versions v4-v7 saved per turn;
the tool bar folding at run end; STOP mid-run clean (no DbError, no banner); the NEXT message
reciting the earlier work from retained context. Suites: gateway 1,170 · web 1,762 ·
contracts 19(events) · api-client green · typecheck 10/10 · biome clean.

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

## Round 14 hotfix — 2026-11-01 (local-smoke, live browser)

**Found by driving the REAL stack end-to-end** (headless browser: sign-in → editor →
chat send → engine + DB assertions), not by reading tests. The pipeline held
(carriers live-applied, 2 "Agent apply" versions saved, engine showed the layers)
but the run-end plan card stayed "proposed" with live Apply/Cancel buttons on work
that had ALREADY landed, under the hint "Auto-apply is on — review the plan, then
press Apply."

Root cause: finishRun's all-live-applied branch committed `chat.plan.applied`
DIRECTLY. The run-state fold only collapses `applied` from outcome "applying"
(the round-13 two-step pin), and a fresh run-end card sits at "idle" — so the
commit was a silent no-op. The stranded card was a re-apply trap: auto-drive
skips it (autoAppliedRuns) and a user pressing Apply re-executed the full merge
against the live versions → 409 VERSION_CONFLICT ("The edit didn't apply —
nothing changed.") or duplicate layers. This is also the most plausible carrier
of the user-reported "pressed Apply, nothing happened" reports.

Fix: finishRun now runs the SAME two-step the maybeAutoApply and salvage paths
run — `chat.plan.apply` (idle → applying) then `chat.plan.applied` (applying →
applied with the last live versionId). Pinned by a new chat-controller test
("round-14 hotfix: an all-live-applied run folds its plan card to APPLIED");
mutation-verified (pin fails on the old code), 1,768/1,768 web green, typecheck +
biome clean. Verified live in the browser: the card settles "Applied — Version
ver_… · one undo step" with Undo / View in timeline / Version history.

Deployments note: the user-facing screenshot ("step limit" + empty engine +
successful tool chips) came from the DEPLOYED instance still running pre-round-14
code — the local dev DB had zero user runs. The fixes exist on main; the deploy
must pull + rebuild.
