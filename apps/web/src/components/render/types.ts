// @studio/web — the M8-I render surface ports (BUILD_PLAN §M8 task 2/3;
// DECISIONS D-2/D-11/D-12/D-18).
//
// Everything the dialog, the history drawer and the header region consume is
// declared HERE as narrow, structural types so every component is testable at
// the api-client boundary (the M7-F CommentsClient precedent): production
// passes the real workspace-scoped `ApiClient`, tests pass the same shape.

import type { ApiClient } from "@studio/api-client";
import type { EditorBridge } from "@studio/editor-bridge";

/**
 * The renders slice of the api-client (M8-D's v2 surface — structural, so
 * tests inject the same shape without a real client).
 */
export type RenderClient = Pick<ApiClient, "renders">;

/**
 * A resolved workspace+project scope for the render surfaces: the ONE
 * workspace-scoped client every render call rides (the gateway's
 * `requireWorkspace` reads `x-workspace-id` off the instance) plus the
 * project the editor route has open.
 */
export interface RenderProjectScope {
  readonly client: RenderClient;
  readonly projectId: string;
  /** Display name for the comp chip / drawer header; null when unknown. */
  readonly projectName: string | null;
}

/**
 * The live composition the dialog prefills from (the bridge's `comp.info`
 * seam — engine query.rs; read-only, so it passes the M7-G lease gate).
 * `compId` is the WIRE value the queue body carries: the comp's NAME (the
 * presence-beat precedent — `project.summary` name, falling back to the raw
 * id) because the effectcraft CLI resolves comps by name and reports them by
 * name (`docs/phases/m8-cli-spike.md` §3).
 */
export interface RenderComp {
  readonly compId: string;
  readonly compName: string;
  /** Native comp pixel size; null when the engine did not report it. */
  readonly width: number | null;
  readonly height: number | null;
  /** Frames per second; null when unknown (30 is the dialog fallback). */
  readonly frameRate: number | null;
  /** Total duration in seconds; null when unknown. */
  readonly durationSeconds: number | null;
  /** Comp in/out (work area) in seconds — the range defaults; null unknown. */
  readonly workFrom: number | null;
  readonly workTo: number | null;
}

/** Why a project scope could not be resolved (region/drawer error copy). */
export type RenderScopeProblem =
  | "no-route"
  /** me/projects scan found no live project with the route's slug. */
  | "not-found"
  /** The authed session expired / the user is signed out. */
  | "unauthorized"
  /** Network or server failure during resolution. */
  | "failed";

/** The result of the lazy project-scope resolution. */
export type RenderScopeResult =
  | { readonly kind: "ok"; readonly scope: RenderProjectScope }
  | { readonly kind: "error"; readonly problem: RenderScopeProblem };

/** The resolver the region runs on first use (tests inject a fake). */
export type RenderScopeResolver = () => Promise<RenderScopeResult>;

/** Bridge seam for the comp collector (tests pass a fake-editor bridge). */
export type RenderBridgeSource = Pick<EditorBridge, "inspect" | "query">;
