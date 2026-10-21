// Suspense fallback for the auth forms (W8-B) — mirrors the card content so
// the (auth) layout card never flashes empty while Next resolves
// useSearchParams during a static prerender. Server-compatible (pure markup).

export function AuthFormFallback() {
  return (
    <div className="space-y-4" aria-busy="true">
      <div className="h-6 w-40 rounded-md bg-surface-muted" />
      <div className="h-9 w-full rounded-md bg-surface-muted" />
      <div className="h-9 w-full rounded-md bg-surface-muted" />
      <div className="h-9 w-full rounded-md bg-surface-muted" />
    </div>
  );
}
