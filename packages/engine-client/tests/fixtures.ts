// tests/fixtures.ts — typed loader for the recorded-style reply fixtures (§21).
//
// Loading strategy: every specifier is a literal string concatenation, which esbuild
// (vitest's transform) folds into a static import the JSON module loader resolves, while
// `tsc` never resolves concatenated specifiers — so the suite typechecks without
// resolveJsonModule (absent from tsconfig.base.json and not this package's to change)
// and runs everywhere vitest does. A manifest also gives the fixture corpus one obvious
// home and keeps fixture names grep-able.

export interface Exchange {
  $comment?: string | string[];
  request: Record<string, unknown>;
  reply: Record<string, unknown>;
  /** Second recorded variant (error-transport.json: the oversized-line reply). */
  reply_oversized?: Record<string, unknown>;
}

const LOADERS: Readonly<Record<string, () => Promise<{ default: Exchange }>>> = {
  "auth-ok": () => import("../fixtures/replies/auth-ok" + ".json"),
  "auth-rejected": () => import("../fixtures/replies/auth-rejected" + ".json"),
  "doc-new": () => import("../fixtures/replies/doc-new" + ".json"),
  "session-list": () => import("../fixtures/replies/session-list" + ".json"),
  "doc-inspect": () => import("../fixtures/replies/doc-inspect" + ".json"),
  "doc-render-base64": () => import("../fixtures/replies/doc-render-base64" + ".json"),
  "doc-render-path": () => import("../fixtures/replies/doc-render-path" + ".json"),
  "engine-commands": () => import("../fixtures/replies/engine-commands" + ".json"),
  "batch-results": () => import("../fixtures/replies/batch-results" + ".json"),
  "error-bad-params": () => import("../fixtures/replies/error-bad-params" + ".json"),
  "error-unknown-method": () => import("../fixtures/replies/error-unknown-method" + ".json"),
  "error-transport": () => import("../fixtures/replies/error-transport" + ".json"),
  methods: () => import("../fixtures/replies/methods" + ".json"),
};

/** Fixture names, in corpus order (the drift and contract suites iterate these). */
export const FIXTURE_NAMES = Object.keys(LOADERS) as readonly string[];

/** Load one recorded exchange by fixture name. */
export async function loadReply(name: string): Promise<Exchange> {
  const loader = LOADERS[name];
  if (loader === undefined) {
    throw new Error(`unknown engine-client fixture: ${name}`);
  }
  return (await loader()).default;
}
