"use client";

// apps/web — run-creation hook (W8-D): POST /v1/runs (§13.1, §3.3 step 2).
//
// The POST hook for the prompt composer. Responsibilities, and nothing else:
//   - hold ONE idempotency key per run-intent (§3.4): retries of the same
//     submit replay the same gateway run — never a second reservation;
//   - export the lazily-built gateway client for the composer's reads;
//   - send the camelCase CREATE_RUN body and Zod-validate the 201 response;
//   - narrow every failure into the typed RunCreateError states (§13.3):
//     402 → insufficient_credits (credits CTA), 429 → retry-after display;
//   - invalidate the credits query after a create so the balance the user
//     sees reflects the fresh reservation (§14.2 rule 1).
//
// The pure mapping/schema/idempotency logic lives in ./run-contract.ts and is
// unit-tested there; this file is the thin React Query binding.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef } from "react";
import { createGatewayClientFromEnv, type GatewayClient } from "@/lib/api";
import {
  CREDITS_QUERY_KEY,
  createRunIdempotencyKey,
  createRunResponseSchema,
  mapRunCreateError,
  type CreateRunRequest,
  type CreateRunResponse,
  type RunCreateError,
} from "./run-contract";

/** Typed result envelope for one create attempt (docs/AGENTS.md error style). */
export type RunCreateOutcome =
  | { readonly ok: true; readonly run: CreateRunResponse }
  | { readonly ok: false; readonly error: RunCreateError };

/**
 * The gateway client, lazily built on first call. Module-scope memo: env
 * parsing (src/lib/env.ts) must not run at import time — `next build`
 * prerenders this module without a `.env` (fail-fast at first use, §4).
 * Exported so the composer's catalog/documents/credits reads share it.
 */
let gatewayClient: GatewayClient | null = null;

export function getGatewayClient(): GatewayClient {
  if (gatewayClient === null) {
    gatewayClient = createGatewayClientFromEnv();
  }
  return gatewayClient;
}

/** camelCase wire body for CREATE_RUN_BODY_SCHEMA (strict — no extra keys). */
function toWireBody(request: CreateRunRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    documentId: request.documentId,
    prompt: request.prompt,
    tier: request.tier,
  };
  if (request.templateId !== undefined) {
    body.templateId = request.templateId;
  }
  if (request.assetIds !== undefined && request.assetIds.length > 0) {
    body.assetIds = [...request.assetIds];
  }
  return body;
}

export interface UseRunCreate {
  /** True while the POST is in flight (submit button's pending state). */
  readonly pending: boolean;
  /** The mapped failure of the last attempt; null while none/cleared. */
  readonly error: RunCreateError | null;
  /**
   * Create the run. Resolves with a typed envelope — it NEVER rejects, so the
   * composer's submit handler can branch on `ok` without try/catch. Retries
   * reuse the same idempotency key until one attempt succeeds (§3.4).
   */
  readonly createRun: (request: CreateRunRequest) => Promise<RunCreateOutcome>;
  /**
   * Clear the rendered failure WITHOUT minting a new key — the next submit
   * still replays the same intent (a retry after a 402 top-up, §14.2 r1).
   * The key itself is dropped on success, so the next run is always fresh.
   */
  readonly dismissError: () => void;
}

export function useRunCreate(): UseRunCreate {
  const queryClient = useQueryClient();
  /** §3.4: one key per run-intent; null → mint on the next submit. */
  const idempotencyKeyRef = useRef<string | null>(null);

  const mutation = useMutation<CreateRunResponse, unknown, CreateRunRequest>({
    mutationFn: async (request: CreateRunRequest): Promise<CreateRunResponse> => {
      let key = idempotencyKeyRef.current;
      if (key === null) {
        key = createRunIdempotencyKey();
        idempotencyKeyRef.current = key;
      }
      // The key is passed explicitly so transport-level retries inside the
      // client keep replaying the same intent (§13: header or body field).
      return getGatewayClient().post("/runs", {
        body: toWireBody(request),
        idempotencyKey: key,
        schema: createRunResponseSchema,
      });
    },
    onSuccess: () => {
      // The intent completed — a later "run again" is a NEW run (fresh key).
      idempotencyKeyRef.current = null;
      // §14.2 rule 1: the reservation changed the balance — refresh the card.
      void queryClient.invalidateQueries({ queryKey: CREDITS_QUERY_KEY });
    },
  });

  const error = useMemo<RunCreateError | null>(
    () => (mutation.error === null ? null : mapRunCreateError(mutation.error)),
    [mutation.error],
  );

  async function createRun(request: CreateRunRequest): Promise<RunCreateOutcome> {
    try {
      const run = await mutation.mutateAsync(request);
      return { ok: true, run };
    } catch (thrown: unknown) {
      return { ok: false, error: mapRunCreateError(thrown) };
    }
  }

  function dismissError(): void {
    // Keeps idempotencyKeyRef — an edit-then-retry that did not change intent
    // may still replay the same run (§3.4). Only onSuccess clears the key.
    mutation.reset();
  }

  return { pending: mutation.isPending, error, createRun, dismissError };
}
