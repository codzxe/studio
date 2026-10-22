# M4-L — Web full-loop chat integration test

Task ID: M4-L · Agent: M4-L (web chat integration, wave 3)
Path owned: `apps/web/tests/chat-integration.test.tsx` (NEW — the only path)

## What this is

The ONE suite that composes the REAL browser-side M4 stack end-to-end and fakes
ONLY the wire. Every prior M4 web test sliced one layer in isolation
(provider.test = wiring brain without wave-2 UI; chat-controller.test = engine
with a FakeChatClient; context/tool-executor tests = seams against the fake
bridge; wave-2 component tests = props-driven). This file closes the loop:

```
user types in the REAL composer (ChatPanelSlot → ChatComposer)
  → ChatProvider.send (context collect → lazy thread → engine send)
    → REAL createChatController → fake wire (chat.stream segments recorded)
      → §7.4 events fed by hand → REAL foldEvent → useSyncExternalStore
        → provider diff → REAL createToolExecutor → REAL fake bridge queries
          → runs.postEvent recorded (exact RUN_EVENT body)
            → tool.result echo → message.delta → credits → run.completed
              → ChatThread renders: text + ToolCard(done) + credits line
```

- Mount: `<ChatProvider>{(api) => <ChatPanelSlot api={api} …/>}</ChatProvider>` —
  the real composed panel (header/strip/popover/thread/composer/footer), the
  api captured via the render-prop for state assertions.
- Fake editor: `createFakeEditor({ comps: [{ name: "Main" }] })` +
  `layer.newText "Headline"` — REAL comp/layer/selection/props data flows
  through collectContextSnapshot, the strip chips, and the get_context result.
- Fake wire: threads.create / models.list / chat.stream (segments recorded,
  handlers handed back) / runs.postEvent. `dropOnce`/`dropToPause`/handle
  `reconnect` replay the documented sse.ts §8.4 contract (same-idempotency-key
  re-POST per attempt, pause after 3, resume re-POST on retry).

## Scenario → test-name map (for the M4 evidence file)

| # | Scenario | Test name (file: describe > it) |
|---|----------|--------------------------------|
| 1 | Full read-agent loop | `full read-agent loop (flagship)` > "composer send → SSE run → executor queries the bridge → gated tool.result POST → final answer + tool card + credits render" |
| 2 | Context flags accuracy | `context accuracy (chips mirror the wire)` > "popover removal drops the selection block: absent from the snapshot + strip, and the next chat POST carries context.selection === false" |
| 2b | Model default absent/loaded | same describe > "chat POST body omits the model key entirely when the entitlement fetch failed" |
| 3 | Replay idempotence | `resilience (replay, reconnect, pause)` > "replay idempotence: the same event list folded twice leaves ONE assistant message, ONE card, ONE execution" |
| 4 | Reconnect | same describe > "reconnect: a transport drop shows the Reconnecting… banner, re-POSTs the SAME body (same idempotencyKey), and the replay + tail complete the run" |
| 5 | RUN_PAUSED | same describe > "RUN_PAUSED: three failed attempts park the run with the RunPausedBanner, and the banner's Retry resumes the SAME run (same key) to completion" |
| 6 | Plan card (M4.6) | `read-only guarantees (M4.6)` > "plan card: a §7.4 plan event renders the informational card (risk, steps, ≈credits, the M5 note) and NO Apply control exists anywhere" |
| 7 | Write tool forbidden | same describe > "write tool refusal: studio.set_properties posts TOOL_FORBIDDEN without touching the bridge, and the card renders failed" |
| 8 | Steer queue | `steer queue (§3.4)` > "a composer send while streaming renders immediately, waits for the run to settle, then flushes as a second POST with a FRESH idempotency key" |

## Key wire facts asserted (closeout evidence)

- Chat POST body (CHAT_REQUEST_SCHEMA): keys exactly [message, context, pinned,
  idempotencyKey, model?] — model `studio-fast` when entitlements load, ABSENT
  when they fail; idempotencyKey ≥ 8 chars (UUID); context = the provider's
  effective flags object verbatim.
- Tool result POST (/v1/runs/:id/events): `{type:"tool.result", toolCallId,
  result}` + Idempotency-Key `toolresult:run_1:call_ctx`; get_context result
  keys exactly [projectSummary, activeComp, selection, playhead, focusedPanel,
  selectedProperties, recentCommands] per DEFAULT+auto flags, with the fake
  editor's REAL data (comp Main, layer 1 "Headline", selection [1], playhead
  0s, panel Viewer, transform/position [960,540,0], text/sourceText
  "Headline") and DEFAULT-off recentCommands === "removed by user".
- Reconnect/pause: every re-POST carries the SAME body (deep-equal incl.
  idempotencyKey); RunPausedBanner's Retry resumes the same run (5th segment,
  same key); replayed seqs re-execute NOTHING (project.summary query delta 1).
- M4.6: plan card has NO Apply/Cancel button anywhere; a write tool posts
  {error:"TOOL_FORBIDDEN"} with ZERO bridge queries/executes/batches.

## Gates

- `pnpm --filter @studio/web typecheck` — 0 errors.
- `pnpm --filter @studio/web test` — 430/430 GREEN (35 files: the prior 384 +
  my 9 + M4-N's landed 37; my file 9/9, ~7.4s test time — the two §11-poll
  scenarios cost ~1.1s each of REAL timer wait by design, everything else is
  microtask-speed).
- Biome: my file clean (`biome check tests/chat-integration.test.tsx`).
  `pnpm run lint` (src+tests scope) exits 1 ONLY from M4-N's in-flight
  `src/lib/chat/__tests__/injection-corpus.{ts,test.tsx}` (format +
  organizeImports) — their paths, mid-flight at my gate, not touched (law #12).

## Bugs found (reported, not fixed — none in my ownership)

1. **None blocking.** The full loop is green against the landed wave-1/2 code.
2. Observations worth recording (behaviors, not bugs):
   - `ChatProvider` only updates its internal `inspect` state from the 1 Hz
     poll (`setInterval` — no immediate tick on `panelVisible`), so the AUTO
     selection flags land ~1s after panel open. Deterministic but worth
     knowing for M5 UX (a "selection exists" chip appears a beat after open).
     Workaround-avoided: the tests wait for the poll rather than forcing flags.
   - The executor's get_context `recentCommands` block reports
     `"removed by user"` when the flag is off (DEFAULT-off), i.e. the model is
     told about REMOVED context but not given cheap free data — as pinned.
     Verified end-to-end in the flagship.
   - `editor-host.test.tsx` mocks ChatPanelSlot and mentions
     `chat-panel-slot.test.tsx` in a comment ("the slot's own composition
     suite lives in chat-panel-slot.test.tsx") — that file did NOT exist
     before M4-L; this suite is the first to mount the REAL slot (the comment
     is now effectively true, but the file name differs — orchestrator may
     want the comment updated at closeout; editor-host.tsx/test are not mine).

## Fleet notes

- Commit 0ea72cb (git-sync: OK) swept peers' in-flight files per the add -A
  protocol: M4-M's `apps/web/e2e/**` + `playwright.config.ts` + tsconfig
  exclude line, M4-N's `apps/web/src/lib/chat/__tests__/**` +
  `services/gateway/tests/injection.test.ts`, M4-K's
  `services/gateway/tests/chat-loop.test.ts`, plus tool-results scratch.
  Content untouched by me; owners continue on top.
- The vitest include (`tests/**/*.test.{ts,tsx}` + `src/**`) already covers
  `apps/web/tests/` — no config change was needed (verified before writing).
