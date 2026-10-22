# M4-F — chat thread (wave-2 UI): messages, safe markdown, tool cards, plan card, banners, quick actions, virtualized window

Task ID: M4-F
Files owned (and delivered): `apps/web/src/components/chat/{thread,message,markdown,tool-card,plan-card,banners}.tsx` + colocated `*.test.tsx` (6 + 6).
Gates: my 72 tests green (3 consecutive runs, ~0.7s test time), typecheck 0 errors in my files, biome clean on all 12 files.

## Exported surface (wave-2 contract, verbatim)

```ts
// thread.tsx ('use client')
export interface ChatThreadProps {
  messages: readonly ChatUiMessage[];
  phase: RunPhase;
  activeRunId: string | null;
  onRetry(): void;
  emptyQuickActions: readonly { label: string; prompt: string }[];
  error?: ChatUiError; // DOCUMENTED DEVIATION — see below
}
export function ChatThread(props: ChatThreadProps): ReactElement;
export const CHAT_QUICK_ACTION_EVENT = "studio:chat-quick-action"; // additive export, see contract below

// message.tsx ('use client')
export interface ChatMessageViewProps { message: ChatUiMessage; isStreaming: boolean }
export function ChatMessageView(props: ChatMessageViewProps): ReactElement;

// markdown.tsx
export function renderMarkdown(text: string): ReactNode[]; // internal export (also used by tests)
export function Markdown({ text }: { text: string }): ReactElement;

// tool-card.tsx ('use client')
export interface ToolCardProps { card: ToolCardState }
export function ToolCard(props: ToolCardProps): ReactElement;
export const TOOL_CARD_LABELS: Readonly<Record<string, string>>; // for M4-J reuse

// plan-card.tsx (informational ONLY in M4 — no Apply/Cancel)
export interface PlanCardProps { plan: EditPlan; applied: false; note?: string }
export function PlanCard(props: PlanCardProps): ReactElement;

// banners.tsx
export interface ChatBannerProps { kind: "info" | "warning" | "error" | "success";
  message: string; actionLabel?: string; onAction?: () => void; onDismiss?: () => void }
export function ChatBanner(props: ChatBannerProps): ReactElement;
export function RunPausedBanner(props: { onRetry: () => void }): ReactElement;
```

## The ONE deviation: `error?: ChatUiError` on ChatThreadProps

The pinned five-field ChatThreadProps (M4-SEAMS "Wave-2 UI contract") has no
error surface, but M4-F brief behavior (4) requires the thread to render
RUN_PAUSED (RunPausedBanner) vs other errors (error banner + Retry when
retryable) — impossible without the engine's `ChatUiState.error`. Resolution:
ONE optional additive field. The pinned five-field call still typechecks
(superset), so nothing downstream breaks. **M4-J: pass
`error={state.error}`** (state from the chat controller's `getSnapshot()`).
RUN_PAUSED arrives with `phase: "failed"` (M4-B's `chat.paused` action).

## Quick-action CustomEvent contract (M4-J MUST listen)

Empty-thread chips (data-testid `chat-quick-action`, `data-prompt` attr) and
M4-G's composer chips (data-testid `chat-composer-quick-action`) BOTH dispatch
on `window`:

```ts
import { CHAT_QUICK_ACTION_EVENT } from "@/components/chat/thread"; // "studio:chat-quick-action"
window.addEventListener(CHAT_QUICK_ACTION_EVENT, (event) => {
  const prompt = (event as CustomEvent<string>).detail; // string
});
```

(M4-G converged on the identical event name + detail independently — verified
in their composer.tsx:138; the wire shape is now de facto wave-wide.)

## Facts for M4-J

- Mount: `<ChatThread messages={state.messages} phase={state.phase}
  activeRunId={state.activeRunId} onRetry={() => void controller.retry()}
  error={state.error} emptyQuickActions={[{label:"Explain this comp",
  prompt:"Explain what's on this comp"}, …]} />` — root is
  `flex min-h-0 flex-1 flex-col`, drop it straight into the panel's flexible
  slot; the scroller (`chat-thread-scroll`, role="log", aria-live="polite")
  is `flex-1 overflow-y-auto scrollbar-thin`.
- aria-live: the PERSISTENT scroller is the live region (role=log), not the
  inner list — a list that mounts with its first message would not be
  announced; document-worthy reading of the pin "aria-live on the thread list".
- Virtualization: >50 messages → renders the last 40 + a 20px spacer
  (`chat-window-spacer`, `data-hidden-count` = hidden count). Deterministic.
- Scroll anchoring: appends/deltas anchor to bottom ONLY while already within
  32px of the bottom (tracked on scroll via a ref). The effect keys on a cheap
  content signature (Σ text.length + toolCards.length) so mid-list streamed
  text (steer queue) re-anchors too.
- ToolCard: collapsed by default; the whole header line is the toggle button
  (aria-expanded/aria-controls, §9.2). Copy = JSON `{name,args,result}` with
  pngBase64 REDACTED (image bytes never hit text or clipboard);
  `studio.render_preview` results render an `<img data-testid="tool-card-image">`
  (data:image/png;base64). Failed cards extract `result.message ?? result.error`.
  `deltaText` is intentionally NOT rendered in M4 (tool.delta is unused by the
  4 read tools) — note for M5 if delta streaming lands.
- PlanCard: note defaults to "Apply arrives with M5 — this plan is a preview.";
  `applied` is the literal `false` (M5 widens); zero buttons in the card
  (tested: `queryByRole("button")` is null).
- RUN_PAUSED banner copy comes from `RUN_PAUSED_ERROR` imported from
  `@/lib/chat/run-state` (banner can never drift from the reducer).
- Marked renderers: user markdown uses the same safe Markdown component; the
  "Thinking…" skeleton (chat-thinking) shows when the active run's text is
  still empty.
- Test ids: chat-thread, chat-thread-scroll, chat-thread-list, chat-message
  (+ data-role), chat-message-label, chat-markdown, chat-md-code, chat-caret,
  chat-thinking, chat-credits, chat-empty-state, chat-quick-action,
  chat-window-spacer, chat-banner (data-kind), chat-banner-run-paused,
  chat-banner-action, chat-banner-dismiss, tool-card (+ data-status/data-tool),
  tool-card-toggle/summary/details/args/result/copy/image,
  plan-card (+ data-risk/intent/applied/requires-approval),
  plan-intent/plan-risk/plan-steps/plan-affected/plan-credits/plan-note.

## Environment notes

- `getByText` only matches DIRECT text nodes — mixed inline content (bold inside
  a sentence) must be asserted via `container.textContent`.
- JSX drops the newline/space between an element and the following bare text —
  the ✦ Agent label needs `{" Agent"}` to keep a real space.
- jsdom: `navigator.clipboard` and `document.execCommand` are BOTH undefined;
  copy tests stub them with `Object.defineProperty(..., {configurable: true})`
  + `Reflect.deleteProperty` cleanup.
- Fleet state at my close: the single web-suite failure is M4-J's in-flight
  `editor-host.test.tsx` "chat layer" test (10s timeout, mid-wiring) and
  provider.test.tsx typecheck churn — theirs, untouched (law #12).
