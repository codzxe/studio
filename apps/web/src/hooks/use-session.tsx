"use client";

// apps/web — placeholder session context + api-client hooks (W8-A).
//
// The product shell (components/shell/*, app/(app)/*) reads the user,
// workspaces and run-credit balance from this context; the dashboard reads
// recent documents/runs and creates documents — ALL through the typed
// gateway client in src/lib/api.ts (spec §13: the web app talks only to the
// gateway, never to the engine/DB/queue).
//
// Wire contracts: every zod schema below mirrors the gateway's OpenAPI
// (apps/gateway/src/openapi.ts): /v1/me (provisional), /v1/workspaces,
// /v1/credits (provisional), /v1/documents, /v1/runs. Keep both sides in
// sync; contract drift throws ZodError inside the query (surfaced as an
// error state, never a crash).
//
// TODO(W8-B auth wiring) — the known seams, in one place:
//   1. Better Auth (`better-auth/react`) owns the session; useSignOut's raw
//      POST /auth/sign-out is replaced by `authClient.signOut()`.
//   2. Server-side session gate for app/(app)/layout.tsx (redirect to
//      /sign-in). Until then the shell renders for everyone and gateway
//      calls answer 401 — components render typed error states.
//   3. Workspace switching is client-only state today: the gateway derives
//      the active organization from the session (middleware/auth-context.ts),
//      so `setActiveWorkspaceId` refetches but cannot yet re-scope server
//      data. When the active-workspace mechanism lands (header/query), it is
//      added in the client factory below; queries already key by
//      activeWorkspaceId so a switch refetches with zero component changes.
//   4. /v1/me and /v1/credits are "not-implemented" gateway routes today —
//      the shell shows their typed error states until the route wave lands.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createGatewayClientFromEnv, isApiError, type GatewayClient } from "@/lib/api";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Wire contracts (zod at every boundary; mirrors apps/gateway/src/openapi.ts)
// ---------------------------------------------------------------------------

/** Better Auth organization roles (§15.2 RBAC; openapi ROLE_ENUM). */
const workspaceRoleSchema = z.enum(["owner", "admin", "editor", "viewer"]);

/** openapi WorkspaceSummary — GET /v1/workspaces page item. */
const workspaceSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  slug: z.string(),
  role: workspaceRoleSchema,
  created_at: z.coerce.date(),
});

const workspacesResponseSchema = z.object({
  ok: z.literal(true),
  workspaces: z.array(workspaceSummarySchema),
});

/** openapi GET /v1/me user object (provisional shape, audit D2). */
const sessionUserSchema = z.object({
  id: z.string().min(1),
  email: z.string(),
  name: z.string(),
});

const meResponseSchema = z.object({
  ok: z.literal(true),
  user: sessionUserSchema,
  memberships: z.array(workspaceSummarySchema),
});

/**
 * openapi GET /v1/credits (provisional). Only the balance is consumed by the
 * shell badge; the ledger page renders in the billing wave.
 */
const creditsResponseSchema = z.object({
  ok: z.literal(true).optional(),
  balance: z.number(),
});

/** openapi DocumentDto — GET /v1/documents page item. */
const documentSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  width_px: z.number().int().positive(),
  height_px: z.number().int().positive(),
  current_revision: z.number().int().nonnegative(),
  template_id: z.string().nullable(),
  created_by: z.string(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
  archived_at: z.coerce.date().nullable(),
});

const documentsResponseSchema = z.object({
  ok: z.literal(true),
  documents: z.array(documentSummarySchema),
  next_cursor: z.string().optional(),
});

/** openapi RunListItem — GET /v1/runs page item (note: no `ok` wrapper). */
const runListItemSchema = z.object({
  run_id: z.string().min(1),
  document_id: z.string().min(1),
  status: z.string(),
  tier: z.string(),
  revision_before: z.number().int(),
  revision_after: z.number().int().nullable(),
  created_at: z.coerce.date(),
  started_at: z.coerce.date().nullable(),
  finished_at: z.coerce.date().nullable(),
  error: z.unknown().nullable(),
  credits: z.object({
    reserved: z.number(),
    charged: z.number(),
  }),
});

const runsResponseSchema = z.object({
  runs: z.array(runListItemSchema),
  next_cursor: z.string().optional(),
});

/** openapi VersionDto — part of the POST /v1/documents 201 response. */
const versionSchema = z.object({
  id: z.string(),
  revision: z.number().int(),
  label: z.string(),
  created_by: z.string(),
  created_at: z.coerce.date(),
});

const createdDocumentResponseSchema = z.object({
  ok: z.literal(true),
  document: documentSummarySchema,
  version: versionSchema,
});

export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;
export type SessionUser = z.infer<typeof sessionUserSchema>;
export type DocumentSummary = z.infer<typeof documentSummarySchema>;
export type RunListItem = z.infer<typeof runListItemSchema>;

// ---------------------------------------------------------------------------
// Session context
// ---------------------------------------------------------------------------

/** Loading/ready/error triple shared by every session-facing fetch. */
export interface SessionFetchState {
  readonly status: "loading" | "ready" | "error";
  /** User-safe message when status is "error" (§13.3 never leaks internals). */
  readonly message: string | null;
}

export interface SessionContextValue {
  /** Placeholder identity — null until GET /v1/me resolves (TODO(W8-B)). */
  readonly user: SessionUser | null;
  readonly userState: SessionFetchState;
  /** Workspace memberships in gateway order. */
  readonly workspaces: readonly WorkspaceSummary[];
  readonly workspacesState: SessionFetchState;
  /** First workspace by default; switched via setActiveWorkspaceId. */
  readonly activeWorkspace: WorkspaceSummary | null;
  readonly activeWorkspaceId: string | null;
  readonly setActiveWorkspaceId: (workspaceId: string) => void;
  /** Run-credit balance for the badge (§14.1 credits). */
  readonly credits: SessionFetchState & { readonly balance: number | null };
  /** Refetch every session-scoped query (retry affordance for error states). */
  readonly refreshSession: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);
const GatewayClientContext = createContext<(() => GatewayClient) | null>(null);

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (context === null) {
    throw new Error("useSession must be used inside <SessionProvider>.");
  }
  return context;
}

/**
 * The lazily-built gateway client accessor. Private: the placeholder data
 * hooks below are the only consumers. NEVER call the getter during render —
 * the env read must stay lazy so `next build` prerenders without a .env
 * (src/lib/env.ts contract, W1-K).
 */
function useGatewayClient(): () => GatewayClient {
  const getClient = useContext(GatewayClientContext);
  if (getClient === null) {
    throw new Error("Session data hooks must be used inside <SessionProvider>.");
  }
  return getClient;
}

function toMessage(error: unknown): string {
  // ApiError messages are user-safe by contract (§13.3); anything else
  // (network throw, ZodError) collapses to a generic line.
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

const ME_QUERY_KEY = ["session", "me"] as const;
const WORKSPACES_QUERY_KEY = ["session", "workspaces"] as const;
const creditsQueryKey = (workspaceId: string | null) =>
  ["session", "credits", workspaceId] as const;

export interface SessionProviderProps {
  /**
   * Injected gateway client — tests pass one built around a fake fetch
   * (src/lib/api.ts FetchLike). OMIT this in server components: a client is
   * not serializable across the RSC boundary, and production builds it
   * lazily from NEXT_PUBLIC_ env (never at render/SSR time).
   */
  readonly client?: GatewayClient;
  readonly children: ReactNode;
}

export function SessionProvider({ client, children }: SessionProviderProps) {
  const queryClient = useQueryClient();
  const ownClient = useRef<GatewayClient | null>(null);

  const getClient = useCallback((): GatewayClient => {
    if (client !== undefined) {
      return client;
    }
    if (ownClient.current === null) {
      // Lazy env read: the first real call fails fast naming the missing
      // var (§4); render/SSR never touches process.env (W1-K note).
      ownClient.current = createGatewayClientFromEnv();
    }
    return ownClient.current;
  }, [client]);

  // Client-only workspace selection (TODO(W8-B) — see the file header).
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);

  const meQuery = useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: () => getClient().get("/me", { schema: meResponseSchema }),
  });
  const workspacesQuery = useQuery({
    queryKey: WORKSPACES_QUERY_KEY,
    queryFn: () => getClient().get("/workspaces", { schema: workspacesResponseSchema }),
  });

  const workspaces = useMemo(() => workspacesQuery.data?.workspaces ?? [], [workspacesQuery.data]);

  const activeWorkspace = useMemo(() => {
    const selected = workspaces.find((workspace) => workspace.id === selectedWorkspaceId);
    if (selected !== undefined) {
      return selected;
    }
    return workspaces[0] ?? null;
  }, [workspaces, selectedWorkspaceId]);

  const activeWorkspaceId = activeWorkspace?.id ?? null;

  // Keyed by the active workspace so a future switch re-scopes data.
  const creditsQuery = useQuery({
    queryKey: creditsQueryKey(activeWorkspaceId),
    queryFn: () => getClient().get("/credits", { schema: creditsResponseSchema }),
  });

  const setActiveWorkspaceId = useCallback((workspaceId: string) => {
    setSelectedWorkspaceId(workspaceId);
  }, []);

  const refreshSession = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["session"] });
  }, [queryClient]);

  const value = useMemo<SessionContextValue>(
    () => ({
      user: meQuery.data?.user ?? null,
      userState: {
        status: meQuery.isPending ? "loading" : meQuery.isError ? "error" : "ready",
        message: meQuery.isError ? toMessage(meQuery.error) : null,
      },
      workspaces,
      workspacesState: {
        status: workspacesQuery.isPending ? "loading" : workspacesQuery.isError ? "error" : "ready",
        message: workspacesQuery.isError ? toMessage(workspacesQuery.error) : null,
      },
      activeWorkspace,
      activeWorkspaceId,
      setActiveWorkspaceId,
      credits: {
        status: creditsQuery.isPending ? "loading" : creditsQuery.isError ? "error" : "ready",
        message: creditsQuery.isError ? toMessage(creditsQuery.error) : null,
        balance: creditsQuery.data?.balance ?? null,
      },
      refreshSession,
    }),
    [
      meQuery,
      workspaces,
      workspacesQuery,
      activeWorkspace,
      activeWorkspaceId,
      setActiveWorkspaceId,
      creditsQuery,
      refreshSession,
    ],
  );

  return (
    <GatewayClientContext.Provider value={getClient}>
      <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
    </GatewayClientContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Placeholder dashboard data hooks (§13.1 surface; swap in place in W8-B+)
// ---------------------------------------------------------------------------

/** Clamp a page size to the gateway's 1..100 `limit` range (openapi). */
function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return 20;
  }
  return Math.min(100, Math.max(1, Math.floor(limit)));
}

const documentsQueryKey = (limit: number, workspaceId: string | null) =>
  ["documents", "recent", limit, workspaceId] as const;

/** Newest documents for the dashboard grid (GET /v1/documents?limit=). */
export function useRecentDocuments(limit = 8) {
  const getClient = useGatewayClient();
  const { activeWorkspaceId } = useSession();
  const size = clampLimit(limit);
  return useQuery({
    queryKey: documentsQueryKey(size, activeWorkspaceId),
    queryFn: () => getClient().get(`/documents?limit=${size}`, { schema: documentsResponseSchema }),
  });
}

const runsQueryKey = (limit: number, workspaceId: string | null) =>
  ["runs", "recent", limit, workspaceId] as const;

/** Latest agent runs for the dashboard strip (GET /v1/runs?limit=). */
export function useRecentRuns(limit = 8) {
  const getClient = useGatewayClient();
  const { activeWorkspaceId } = useSession();
  const size = clampLimit(limit);
  return useQuery({
    queryKey: runsQueryKey(size, activeWorkspaceId),
    queryFn: () => getClient().get(`/runs?limit=${size}`, { schema: runsResponseSchema }),
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface CreateDocumentInput {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** §13.1 `template` key — "id" or "id@version", e.g. "instagram-post@3". */
  readonly templateId?: string;
}

export type CreateDocumentResult =
  | { readonly ok: true; readonly document: DocumentSummary }
  | { readonly ok: false; readonly message: string };

export interface CreateDocumentController {
  readonly pending: boolean;
  readonly createDocument: (input: CreateDocumentInput) => Promise<CreateDocumentResult>;
}

/**
 * POST /v1/documents (§13.1). The gateway's strict body schema takes
 * { name, width, height, templateId?/template? } (audit D3 note in openapi);
 * the client auto-attaches the Idempotency-Key header (§13).
 */
export function useCreateDocument(): CreateDocumentController {
  const getClient = useGatewayClient();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (input: CreateDocumentInput): Promise<DocumentSummary> => {
      const created = await getClient().post("/documents", {
        body: {
          name: input.name,
          width: input.width,
          height: input.height,
          ...(input.templateId !== undefined ? { template: input.templateId } : {}),
        },
        schema: createdDocumentResponseSchema,
      });
      return created.document;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["documents"] });
    },
  });

  const createDocument = useCallback(
    async (input: CreateDocumentInput): Promise<CreateDocumentResult> => {
      try {
        const document = await mutation.mutateAsync(input);
        return { ok: true, document };
      } catch (error) {
        // 402 = insufficient credits (§14.2), 401 = auth not wired yet —
        // both arrive as typed envelopes with user-safe messages (§13.3).
        return {
          ok: false,
          message: isApiError(error)
            ? error.message
            : "Could not create the document. Please try again.",
        };
      }
    },
    [mutation],
  );

  return { pending: mutation.isPending, createDocument };
}

export type SignOutResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export interface SignOutController {
  readonly pending: boolean;
  readonly signOut: () => Promise<SignOutResult>;
}

/**
 * POST /v1/auth/sign-out (Better Auth handler, §13.1) — TODO(W8-B): replaced
 * by `authClient.signOut()` when the Better Auth client lands. Success clears
 * every session-scoped query cache and returns to /sign-in.
 */
export function useSignOut(): SignOutController {
  const getClient = useGatewayClient();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const signOut = useCallback((): Promise<SignOutResult> => {
    setPending(true);
    return (async () => {
      try {
        await getClient().post("/auth/sign-out", { body: {} });
        queryClient.clear(); // drop session-scoped caches (documents, runs, credits)
        router.replace("/sign-in");
        return { ok: true } as const;
      } catch (error) {
        return {
          ok: false,
          message: isApiError(error)
            ? error.message
            : "Could not sign you out. Please try again.",
        };
      } finally {
        setPending(false);
      }
    })();
  }, [getClient, queryClient, router]);

  return { pending, signOut };
}
