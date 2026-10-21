// components/onboarding/demo-project.ts — the "Try the coffee demo" seed
// (§19 Phase 4 onboarding; §24.1 worked example). Pure URL/body builders plus
// a thin injectable POST /v1/documents default. The compose URL is a shared
// contract with W8-D: /compose?template=<id>&brief=<text> — see README.md.

export const DEMO_TEMPLATE_ID = "instagram-post@3"; // §24.1 template path
export const DEMO_DOCUMENT_NAME = "Coffee shop promo (demo)";

/** §24.1 verbatim — the brief the demo prefills into the composer. */
export const DEMO_BRIEF =
  "Coffee shop promo post, warm and cozy, headline 'Fresh roasted, every morning', " +
  "sub 'Open 7–5 · Main St', use the latte photo.";

export const DEMO_CREATE_PATH = "/v1/documents"; // §13 API table

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface CreateDemoDocumentInput {
  /** Workspace's project the document belongs to (omitted when unknown). */
  readonly projectId?: string;
  readonly name?: string;
  readonly templateId?: string;
}

/** POST /v1/documents body per §13: { project_id, name, template }. */
export function buildCreateDocumentBody(
  input: CreateDemoDocumentInput = {},
): { name: string; template: string } & { project_id?: string } {
  const body: { name: string; template: string; project_id?: string } = {
    name: input.name ?? DEMO_DOCUMENT_NAME,
    template: input.templateId ?? DEMO_TEMPLATE_ID,
  };
  if (typeof input.projectId === "string" && input.projectId.length > 0) {
    body.project_id = input.projectId;
  }
  return body;
}

/**
 * The compose prefill URL (W8-D contract): template id and brief are both
 * percent-encoded via URLSearchParams — "@" becomes %40, spaces become +.
 */
export function buildComposeUrl(
  templateId: string = DEMO_TEMPLATE_ID,
  brief: string = DEMO_BRIEF,
): string {
  const params = new URLSearchParams({ template: templateId, brief });
  return `/compose?${params.toString()}`;
}

/** Inverse of buildComposeUrl — W8-D can parity-test its reader against this. */
export function parseComposeUrl(url: string): {
  template: string | null;
  brief: string | null;
} {
  const queryIndex = url.indexOf("?");
  if (queryIndex === -1) return { template: null, brief: null };
  try {
    const params = new URLSearchParams(url.slice(queryIndex + 1));
    return {
      template: params.get("template"),
      brief: params.get("brief"),
    };
  } catch {
    return { template: null, brief: null };
  }
}

/** Best-effort id extraction across plausible create-response shapes. */
export function extractDocumentId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const root = payload as Record<string, unknown>;
  const data =
    typeof root.data === "object" && root.data !== null
      ? (root.data as Record<string, unknown>)
      : null;
  const candidates: unknown[] = [root.id, root.document_id, data?.id, data?.document_id];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return null;
}

export interface DemoSeedOk {
  readonly ok: true;
  readonly documentId: string | null;
}

export interface DemoSeedFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly hint: string;
  readonly retryable: boolean;
}

export type DemoSeedResult = DemoSeedOk | DemoSeedFailure;

/**
 * Seed the demo document via POST /v1/documents. Never throws; failures come
 * back as typed envelopes. Idempotency at the UI level is the caller's job
 * (the card disables itself while a request is in flight).
 */
export async function seedDemoDocument(
  input: CreateDemoDocumentInput = {},
  fetchImpl: FetchLike = fetch,
): Promise<DemoSeedResult> {
  try {
    const response = await fetchImpl(DEMO_CREATE_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      credentials: "same-origin",
      body: JSON.stringify(buildCreateDocumentBody(input)),
    });
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        code: "demo.unauthorized",
        message: "Couldn't create the demo document.",
        hint: "Sign in again, then give it another try.",
        retryable: false,
      };
    }
    if (response.status === 404) {
      return {
        ok: false,
        code: "demo.template-missing",
        message: "The coffee demo template isn't available yet.",
        hint: "Pick any template from the gallery meanwhile.",
        retryable: false,
      };
    }
    if (response.status === 429) {
      return {
        ok: false,
        code: "demo.rate-limited",
        message: "Too many demo documents created just now.",
        hint: "Wait a moment, then try again.",
        retryable: true,
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        code: "demo.create-failed",
        message: "Couldn't create the demo document.",
        hint: "Nothing was charged — retry in a moment.",
        retryable: true,
      };
    }
    const body: unknown = await response.json().catch(() => null);
    return { ok: true, documentId: extractDocumentId(body) };
  } catch {
    return {
      ok: false,
      code: "demo.network",
      message: "Couldn't reach the server.",
      hint: "Check your connection and retry.",
      retryable: true,
    };
  }
}
