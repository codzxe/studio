# apps/worker/tests/spine — the Phase-0 engine spine

Vitest integration suites that prove the **§19 Phase-0 spine end-to-end** — "prove the
spine end-to-end with zero product polish" — plus the **§21 Integration row** ("create
doc, run batch, render, save, reopen, inspect. Failed-command handling") and the
**§3.4 crash-recovery story**, by spawning `apps/mock-engine` (the W2-F
protocol-faithful fake of `photocraft-cli serve`) as a **real child process** and
driving it with the **real `@studio/engine-client` facade** over loopback TCP.

CI cannot run the Rust engine, so the mock stands in for the serve side; everything on
the client side of the wire — transport framing, first-frame auth, id correlation, the
facade's retry/may-have-completed policy — is the production code path.

## Files

| File | Role |
| --- | --- |
| `harness.ts` | Spawns the mock (`MOCK_ENGINE_PORT=0`, 64-hex `MOCK_ENGINE_TOKEN`, temp `MOCK_ENGINE_WRITE_ROOT`), waits for the stderr ready line, wires a real `EngineClient` to it, cleans up. Also the shared `doc.inspect` narrowing. |
| `engine-spine.test.ts` | The happy-path §19/§21 spine (below). |
| `recovery-spine.test.ts` | The §3.4 kill → inspect-first → replay → resume spine. |
| `../../scripts/demo-spine.mjs` | The same flow as a zero-dependency `node` script with a printed command log (Phase-0 step 5) — the mechanics seed for Wave-7 `demo:coffee`. |

## What the spine proves

`engine-spine.test.ts` — one spawned process, one client, in order:

1. **auth** on the first frame (an ok `methods` reply is the proof — nothing is
   served before auth), and a wrong token is `auth_rejected`, non-retryable;
2. **doc.new 1080×1080** → document index 0, inspect shows the canvas `Background`
   layer, revision baseline captured;
3. **batch** `layer.new.layer Background` + `type.create Headline` + `edit.fill` →
   3/3 steps ok, exactly 3 layers afterwards, revision advanced by exactly 3;
4. **doc.render** → PNG with magic bytes `89 50 4E 47`;
5. **doc.save** beneath the automation write root → the file exists on disk;
6. **doc.open** the saved file → doc.inspect shows a layer-bearing document
   (the reopen-persistence canary — see Known deviations);
7. **failed-command handling**: a batch stops at the first failed step
   (`stopOnError`), reports the per-step error, and the engine state reflects
   exactly what ran (revision +1, no phantom layer).

`recovery-spine.test.ts` — the §3.4 sequence:

1. **checkpoint**: doc.new → batch → doc.save pins revision R;
2. **crash**: `MOCK_FAULT=crash-on-command` kills the child (exit 86) while a
   mutating `engine.execute` is in flight; the client surfaces
   `connection_dropped_mid_call` — retryable **false**, hint "the operation **may
   have completed**; **inspect** the document before re-sending" — and the cause
   travels as `data` (§5.7). Edits are never auto-resent (vendor #1007);
3. **resume**: a clean mock restarts on a **new ephemeral port**, `doc.open` reopens
   the checkpoint, the run's remaining commands are **replayed exactly once**, the
   revision advances by exactly the replayed mutations, and the resumed state saves.

## How CI runs it

Root `pnpm test` → `turbo run test` → `@studio/worker`'s `vitest run` picks up
`tests/**/*.test.ts`. Requirements CI satisfies for free: `pnpm install` links the
`@studio/engine-client` workspace dep (its `main` is TS source — vitest transforms
it), and the mock-engine is zero-dependency plain `node`. No network (loopback only),
no extra services; each suite runs in a couple of seconds (spawn + ~10 calls), with
explicit per-test timeouts (15 s) and 3–4 s §3.4 budgets so a stuck engine fails fast.

**Skip-guards**: both suites are wrapped in
`describe.skipIf(!existsSync("apps/mock-engine/src/index.mjs"))` — if the mock moves
or is renamed, the suites *skip* instead of breaking CI (the demo script exits 2 with
a pointed message instead). The engine-client barrel is imported statically: it is a
committed workspace dependency, so there is nothing else optional to guard.

## Known deviations (deliberate)

The mock is fake on purpose (its README › "What is faked"); the spine asserts around
the fakes rather than pretending they are real:

- **doc.render is a fixed 8×8 gray PNG** — the spine asserts the PNG magic bytes
  only, never preview dimensions.
- **doc.open synthesizes** a session document and never reads the saved file — so the
  reopen test asserts the weaker contract unconditionally (a real, layer-bearing
  document came back) and its **persistence canary** enforces full rehydration
  (saved revision + saved layers) only when a future mock is capable of it, skipping
  loudly (a `console.warn` pointing here) otherwise.
- **doc.open/doc.inspect go through the facade's raw `call()`**, not the typed
  wrappers: wrapper replies are validated against strict method schemas
  (`packages/engine-client/src/methods/`), and the mock's `doc.open` reply predates
  that schema — schema parity is the engine-client contract tests' territory, not
  the spine's.
- **The crash lands on a standalone `engine.execute`, not inside a server-side
  batch**: the committed mock fires faults on `engine.execute` dispatch only (its
  `batch` runs steps inside the process without re-entering dispatch), so with the
  fault armed the checkpoint batch is safe and the armed `edit.fill` is the
  deterministic kill. Assertions pin **deltas** (revision advanced by exactly what
  ran), never absolute revision numbers.

## Demo wiring (suggestion — do not apply blindly)

`apps/worker/package.json` is owned by the W1-I worker lineage, so this file records
the suggested script instead of editing it:

```json
"demo:spine": "node scripts/demo-spine.mjs"
```

`node apps/worker/scripts/demo-spine.mjs` from the package dir (zero deps) spawns a
fresh mock, runs the happy path, prints the numbered command log and the artifacts
directory, and exits 0/1/2 (2 = mock-engine missing). `demo:coffee` (Wave 7) wraps the
same flow in a compiled template manifest + critic loop.

## Troubleshooting

| Symptom | Cause → fix |
| --- | --- |
| Suites report *skipped* in CI | `apps/mock-engine/src/index.mjs` not found — the mock moved; update `MOCK_ENGINE_ENTRY` in `harness.ts` (or the skip-guard path). |
| `mock-engine did not announce its port within 15000 ms` | The child died at boot or the box is thrashing — read `handle.stderr` in the failure output; the harness pins `MOCK_ENGINE_PORT=0`, so a busy port is not the cause. |
| `auth_rejected` on the happy path | Token mismatch — the harness generates 64-hex and pins it via `MOCK_ENGINE_TOKEN`; don't pre-set that variable for the test process. |
| `connection_dropped_mid_call` in the happy path | A `MOCK_FAULT` value leaked into the spawned child (it inherits the test process env) — unset it before running the suite. |
| Recovery's replay did not advance the revision | `MOCK_FAULT` still armed on the restarted spawn — the harness arms faults per spawn, so this only happens if `spawnMockEngine` was called with `crashOnExecute` twice. |
| CI flake on a 2-CPU box | Suites are sequential and spawn one node child each; per-test timeouts are 15 s — if the announce step races, the stderr ready line is awaited, so flakes almost always mean a genuinely stuck child (see row 2). |
