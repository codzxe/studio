"use client";

/**
 * `RenderRegion` — the M8-I mount of the render UI (BUILD_PLAN §M8 tasks 2–3;
 * DECISIONS D-2/D-18): the "Render…" entry + history toggle that live in the
 * CHAT OVERLAY HEADER (the one additive wiring point, `chat/header.tsx`), the
 * queue dialog, the history drawer and the queue toast.
 *
 * WHY THIS SHAPE (the CommentsRegion precedent, M7-F): the header is an
 * additive overlay with no access to the editor session's payload, so the
 * region is SELF-SUFFICIENT — it resolves its workspace+project scope lazily
 * (`resolve-project.ts`, on first use, cached) and reads the LIVE comp from
 * the chat layer's bridge via `ChatApiContext` (read-only queries pass the
 * M7-G lease gate, D-23 — queueing pins a version server-side; it is not an
 * engine mutation and never blocks the editor, BP §M8 task 3).
 *
 * Nothing renders or runs until a surface is opened: no network on mount, no
 * timers — a provider-less mount (tests, storybook embeds) degrades to the
 * honest "open a composition" note instead of throwing.
 */

import { ChatApiContext } from "@/lib/chat/provider";
import type { RenderJob } from "@studio/contracts";
import type { EditorBridge } from "@studio/editor-bridge";
import { Button, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@studio/ui";
import { Clapperboard, History } from "lucide-react";
import { type ReactElement, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { collectRenderComp } from "./comp";
import { RenderDialog } from "./render-dialog";
import { RenderHistoryDrawer } from "./render-history-drawer";
import { createRouteScopeResolver } from "./resolve-project";
import type {
  RenderComp,
  RenderProjectScope,
  RenderScopeProblem,
  RenderScopeResolver,
} from "./types";

/** How long the queue toast stays up (the M5-I notice-chip cadence). */
const TOAST_MS = 4_000;

/** Honest copy for the scope problems (never raw internals — law #1). */
const SCOPE_PROBLEM_COPY: Readonly<Record<RenderScopeProblem, string>> = {
  "no-route": "This page is not an editor route, so the project to render could not be resolved.",
  "not-found": "The project to render could not be found. Refresh the page and try again.",
  unauthorized: "Your session expired. Refresh the page and try again.",
  failed: "The render surface could not load. Try again in a moment.",
};

export interface RenderRegionProps {
  /** Test/embed seam: the bridge to read the live comp from. Default: the
   * chat layer's bridge via ChatApiContext (null-tolerant). */
  readonly bridge?: EditorBridge | null;
  /** Test seam: the scope resolver. Default: the route-slug resolver. */
  readonly resolveScope?: RenderScopeResolver;
}

export function RenderRegion({
  bridge: bridgeProp,
  resolveScope,
}: RenderRegionProps): ReactElement {
  // The chat layer's bridge (provider-less mounts read null — never throws).
  const chatApi = useContext(ChatApiContext);
  const bridge = bridgeProp !== undefined ? bridgeProp : (chatApi?.planWiring?.bridge ?? null);

  const [resolve] = useState<RenderScopeResolver>(() => resolveScope ?? createRouteScopeResolver());

  // -- scope state (resolved lazily on first surface open; cached on success) --
  const [scope, setScope] = useState<RenderProjectScope | null>(null);
  const [scopeResolving, setScopeResolving] = useState(false);
  const [scopeProblem, setScopeProblem] = useState<RenderScopeProblem | null>(null);
  const resolvingRef = useRef(false);

  const ensureScope = useCallback((): void => {
    if (scope !== null || resolvingRef.current) return;
    resolvingRef.current = true;
    setScopeResolving(true);
    setScopeProblem(null);
    void resolve().then((result) => {
      resolvingRef.current = false;
      setScopeResolving(false);
      if (result.kind === "ok") setScope(result.scope);
      else setScopeProblem(result.problem);
    });
  }, [resolve, scope]);

  // -- surface state -------------------------------------------------------------
  const [dialogOpen, setDialogOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [comp, setComp] = useState<RenderComp | null>(null);
  const [compResolving, setCompResolving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeCount, setActiveCount] = useState(0);

  const showToast = useCallback((text: string): void => {
    setToast(text);
    if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  useEffect(
    () => () => {
      if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current);
    },
    [],
  );

  /** Read the live comp (read-only bridge query; degrades to null). */
  const refreshComp = useCallback((): void => {
    if (bridge === null) {
      setComp(null);
      return;
    }
    setCompResolving(true);
    void collectRenderComp(bridge).then((collected) => {
      setComp(collected);
      setCompResolving(false);
    });
  }, [bridge]);

  const openDialog = useCallback((): void => {
    ensureScope();
    refreshComp();
    setDrawerOpen(false);
    setDialogOpen(true);
  }, [ensureScope, refreshComp]);

  const openDrawer = useCallback((): void => {
    ensureScope();
    setDialogOpen(false);
    setDrawerOpen(true);
  }, [ensureScope]);

  const onQueued = useCallback(
    (job: RenderJob): void => {
      setDialogOpen(false);
      showToast(`Render queued — ${job.compId} is in Render history.`);
      setDrawerOpen(true);
    },
    [showToast],
  );

  return (
    <>
      <TooltipProvider>
        <div className="flex shrink-0 items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 gap-1 px-2 text-secondary hover:text-primary"
                aria-label="Render…"
                data-testid="render-button"
                onClick={openDialog}
              >
                <Clapperboard size={15} strokeWidth={1.75} aria-hidden="true" />
                <span className="hidden md:inline">Render…</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Queue a cloud render</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="relative h-7 w-7 p-0 text-secondary hover:text-primary"
                aria-label="Render history"
                data-testid="render-history-toggle"
                data-active={activeCount > 0 || undefined}
                onClick={openDrawer}
              >
                <History size={15} strokeWidth={1.75} aria-hidden="true" />
                {activeCount > 0 ? (
                  <span
                    aria-hidden="true"
                    data-testid="render-history-active-dot"
                    className="absolute top-1 right-1 inline-flex h-1.5 w-1.5 rounded-pill bg-signal"
                  />
                ) : null}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Render history</TooltipContent>
          </Tooltip>
        </div>
      </TooltipProvider>

      <RenderDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        client={scope === null ? null : scope.client}
        projectId={scope === null ? null : scope.projectId}
        scopeResolving={scopeResolving}
        scopeError={scopeProblem === null ? null : SCOPE_PROBLEM_COPY[scopeProblem]}
        onRetryScope={ensureScope}
        comp={comp}
        compResolving={compResolving}
        onQueued={onQueued}
      />

      <RenderHistoryDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        client={scope === null ? null : scope.client}
        projectId={scope === null ? null : scope.projectId}
        projectName={scope === null ? null : scope.projectName}
        onActiveChange={setActiveCount}
        onOpenRender={openDialog}
      />

      {toast !== null
        ? createPortal(
            <output
              data-testid="render-toast"
              className="pointer-events-none fixed right-4 bottom-4 z-40 rounded-sm border border-signal/40 bg-panel px-3 py-2 text-body-s text-primary shadow-pop"
            >
              {toast}
            </output>,
            document.body,
          )
        : null}
    </>
  );
}
