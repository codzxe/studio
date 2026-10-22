/**
 * Token estimates for the chat context (EDITOR_CHAT_UX §5.3, PRODUCT_ARCHITECTURE §8.3).
 *
 * Estimates are deliberately cheap and deterministic: `JSON.stringify` length
 * divided by 4 (the classic ~4 chars/token heuristic). The UI labels every
 * estimate with "~" (§5.3 "Token estimates are approximate; label them '~'");
 * nothing here rounds up or claims precision the provider does not give.
 */

/** JSON length / 4, floored at 1 token for any non-empty value; 0 for null/undefined/"". */
export function estimateTokens(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  let text: string;
  try {
    // JSON.stringify returns undefined for functions/symbols and throws for
    // circular refs/bigint — both degrade to String() so estimation never
    // breaks context collection.
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  if (text.length === 0) return 0;
  return Math.max(1, Math.floor(text.length / 4));
}

/** Human label for a token estimate: "~420 tokens" / "~1.2k tokens". */
export function formatTokenEstimate(n: number): string {
  const tokens = Math.max(0, Math.round(n));
  if (tokens < 1000) return `~${tokens} tokens`;
  return `~${(tokens / 1000).toFixed(1)}k tokens`;
}
