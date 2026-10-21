// components/onboarding/demo-project-card.tsx — "Try the coffee demo" (§19
// Phase 4 demo project; §24.1 worked example). One click seeds a demo
// document via POST /v1/documents with template instagram-post@3, then sends
// the user to /compose?template=…&brief=… with the §24.1 brief prefilled
// (URL contract with the compose page owner, W8-D).

"use client";

import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import {
  DEMO_BRIEF,
  DEMO_DOCUMENT_NAME,
  DEMO_TEMPLATE_ID,
  buildComposeUrl,
  seedDemoDocument,
  type CreateDemoDocumentInput,
  type DemoSeedFailure,
  type DemoSeedResult,
} from "./demo-project";
import {
  getBrowserStorage,
  markChecklistStepDone,
  type SafeStorage,
} from "./onboarding-storage";

export interface DemoProjectCardProps {
  /** The workspace's project to attach the seeded document to, if known. */
  projectId?: string;
  /**
   * Injected creator — default: seedDemoDocument (POST /v1/documents via
   * fetch). Hosts with a session-aware gateway client should pass their own.
   */
  createDocument?: (input: CreateDemoDocumentInput) => Promise<DemoSeedResult>;
  storage?: SafeStorage | null;
  /** Overrides the compose prefill URL (defaults to the W8-D contract). */
  composeHref?: string;
  onSeeded?: (documentId: string | null) => void;
  onError?: (failure: DemoSeedFailure) => void;
  className?: string;
}

function CoffeeCupIcon() {
  return (
    <span
      aria-hidden="true"
      className="relative inline-flex h-9 w-9 shrink-0 items-center justify-center"
    >
      <span className="absolute bottom-0.5 left-1 h-[18px] w-[22px] rounded-b-[10px] rounded-t-[4px] border-2 border-amber-600/80 bg-amber-100 dark:border-amber-400/70 dark:bg-amber-400/10" />
      <span className="absolute bottom-[7px] left-[23px] h-[10px] w-[9px] rounded-r-full border-2 border-l-0 border-amber-600/80 dark:border-amber-400/70" />
      <span className="absolute left-[9px] top-0 h-2 w-[2px] animate-pulse rounded-full bg-amber-500/60 motion-reduce:animate-none" />
      <span className="absolute left-[14px] top-1 h-2 w-[2px] animate-pulse rounded-full bg-amber-500/40 motion-reduce:animate-none" />
    </span>
  );
}

export function DemoProjectCard({
  projectId,
  createDocument = seedDemoDocument,
  storage,
  composeHref,
  onSeeded,
  onError,
  className = "",
}: DemoProjectCardProps) {
  const store = useMemo<SafeStorage | null>(
    () => (storage !== undefined ? storage : getBrowserStorage()),
    [storage],
  );
  const router = useRouter();
  const [phase, setPhase] = useState<"idle" | "seeding" | "failed">("idle");
  const [failure, setFailure] = useState<DemoSeedFailure | null>(null);

  const handleTry = useCallback(async () => {
    if (phase === "seeding") return;
    setPhase("seeding");
    setFailure(null);
    const result = await createDocument({
      projectId,
      name: DEMO_DOCUMENT_NAME,
      templateId: DEMO_TEMPLATE_ID,
    });
    if (result.ok) {
      // The demo IS a template pick — the checklist reflects it immediately.
      markChecklistStepDone("pick-template", store);
      onSeeded?.(result.documentId);
      router.push(composeHref ?? buildComposeUrl(DEMO_TEMPLATE_ID, DEMO_BRIEF));
      return;
    }
    setPhase("failed");
    setFailure(result);
    onError?.(result);
  }, [composeHref, createDocument, onError, onSeeded, phase, projectId, router, store]);

  return (
    <div
      className={`rounded-2xl border border-amber-200 bg-amber-50/60 p-4 text-left dark:border-amber-400/20 dark:bg-amber-400/5 ${className}`}
    >
      <div className="flex items-start gap-3">
        <CoffeeCupIcon />
        <div>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Try the coffee demo
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
            One click seeds a coffee-shop promo post — template picked, brief prefilled.
            You land in the composer: press Run and watch it build.
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={handleTry}
        disabled={phase === "seeding"}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
      >
        {phase === "seeding" ? (
          <>
            <span
              aria-hidden="true"
              className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white motion-reduce:animate-none dark:border-zinc-900/40 dark:border-t-zinc-900"
            />
            Setting up your demo…
          </>
        ) : (
          "Try the coffee demo"
        )}
      </button>
      {failure ? (
        <div
          role="alert"
          className="mt-3 rounded-lg bg-red-50 p-3 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300"
        >
          <p className="font-medium">{failure.message}</p>
          <p className="mt-0.5 text-red-600/80 dark:text-red-400/80">{failure.hint}</p>
          {failure.retryable ? (
            <button
              type="button"
              onClick={handleTry}
              className="mt-1.5 font-medium underline underline-offset-2"
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
      <p className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">
        Seeding is free — credits are only spent when you run the agent.
      </p>
    </div>
  );
}
