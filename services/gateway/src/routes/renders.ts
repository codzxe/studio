// @studio/gateway — /v1/renders (§7.2, §9.1): the M8 render API v2.
//
// ROUTE MAP (wire v2, M8-C contracts):
//   POST /v1/renders             queue — editor; QUEUE_RENDER_SCHEMA (the
//                               idempotencyKey rides the BODY as first
//                               shipped, replays ride the Idempotency-Key
//                               HEADER per the global §7.2 middleware) → 201
//                               RenderJob
//   POST /v1/renders/estimate    pure read — viewer; RENDER_ESTIMATE_REQUEST_
//                               SCHEMA; IDEMPOTENCY_EXCLUDED (no key anywhere)
//                               → EstimateResult
//   GET  /v1/renders             history — viewer; RENDERS_QUERY_SCHEMA
//                               (projectId?/status? + house pagination) →
//                               Page<RenderJob>
//   GET  /v1/renders/:id         one job — viewer → RenderJob
//   POST /v1/renders/:id/cancel  cooperative cancel — editor; CANCEL_RENDER_
//                               SCHEMA (optional reason); Idempotency-Key
//                               HEADER → RenderJob (repo CONFLICT on terminal)
//
// THE QUEUE IS THE TABLE (D-25 rationale, as adopted by M8-A): the renders
// table itself is the job queue — a worker process polls Postgres via
// `repos.renders.claimNext` (`SELECT … FOR UPDATE SKIP LOCKED`), so there is
// NO enqueue RPC and NO Valkey/BullMQ dependency on this box. The v1
// Noop RenderWorker seam is REMOVED: a queued row is the entire handoff, and
// the concurrent worker wave (M8-F) claims/heartbeats/settles rows through
// the M8-A repo surface directly.
//
// RENDERS DO NOT TAKE THE EDIT LEASE (DECISIONS D-23, pinned here as ruled):
// the lease gates MUTATIONS only (project PATCH, version upload, agent
// apply/undo). A render is a READ of the PINNED, IMMUTABLE version
// (§9.3) captured at queue time — it can never conflict with an edit, so
// another member holding the lease does not block rendering. No
// requireLeaseForMutation call in this file, by design.
//
// CREDITS (D-12 + D-20 + the M8-B "one formula" rule): the cost is computed
// SERVER-SIDE from the pinned version's actual comp metadata via
// @studio/config's estimateRenderCostUc — the SAME integer µc is the ESTIMATE
// the UI shows, the RESERVE this route holds, and the COMMIT the worker
// settles on completion (credits are charged only for completed renders —
// BP §M8 exit criteria; the worker refunds on cancel/fail). Money crosses
// the wire ONLY as the D-12 whole-credit display number.
//
// The renders.credits COLUMN dialect (pinned, see the queue handler): the row
// stores the integer µc cost, NOT a display number — the repo validates
// `credits` as a non-negative integer (a 0.25-credit minimum-charge render
// cannot be stored as a display number at all), and the landed reconciliation
// core (src/reconciliation.ts, M6-I) sums renders.credits against LEDGER µc
// with the test pinning "µc dialect — the usage side must match the ledger's".
// toJob converts µc → the 2-decimal display at this route boundary.

import { Hono } from "hono";

import {
  CANCEL_RENDER_SCHEMA,
  type EstimateResult,
  QUEUE_RENDER_SCHEMA,
  RENDERS_QUERY_SCHEMA,
  RENDER_ESTIMATE_REQUEST_SCHEMA,
  RENDER_FORMATS,
  type RenderJob,
} from "@studio/contracts";

import {
  type RenderQualityId,
  StudioError,
  entitlementsFor,
  estimateRenderCostDetailUc,
  isRenderFormatEnabled,
  renderMinutesRemaining,
  renderOutputSeconds,
} from "@studio/config";

import type { Project, Render } from "@studio/db";

import type { AppBindings, AppContext, GatewayDeps } from "../context.js";
import { microcreditsToDisplayCredits } from "../credits-display.js";
import { GatewayError } from "../errors.js";
import { ok, page, pathParam } from "../http.js";
import { requireAuth, requireWorkspace } from "../middleware.js";
import { isAdminRole, resolvePlan } from "../plan.js";
import { SIGNED_URL_TTL_SECONDS } from "../signing.js";
import { renderKey } from "../storage.js";
import { audit } from "./projects.js";

// ---------------------------------------------------------------------------
// Comp metadata — parsed from the PINNED version's .ecproj bytes (§9.2)
// ---------------------------------------------------------------------------

/**
 * EffectCraft's exact media time: durations serialize as integer TICKS at
 * 254_016_000_000/s (editor/crates/time — the rate divides evenly into every
 * broadcast frame rate). Verified against a real browser-saved .ecproj.
 */
const EC_TICKS_PER_SECOND = 254_016_000_000;

/** The pieces of a composition the estimator needs (spike §4/§7 shapes). */
interface CompMeta {
  readonly durationSeconds: number;
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** The real editor wire shape: items{"<id>": {id, name, kind:{type:"Comp",…}}}. */
function compFromItems(items: unknown, compId: string): CompMeta | null {
  const map = asRecord(items);
  if (map === null) return null;
  for (const raw of Object.values(map)) {
    const item = asRecord(raw);
    if (item === null) continue;
    // The contract compId is the editor comp id OR its display name — match
    // either (tolerant by design; ids serialize as numbers in .ecproj).
    const idMatches = item.id !== undefined && String(item.id) === compId;
    const nameMatches = typeof item.name === "string" && item.name === compId;
    if (!idMatches && !nameMatches) continue;
    const kind = asRecord(item.kind);
    if (kind === null) continue;
    // serde tag is the VARIANT name ("Comp"); "Composition" is accepted for
    // tolerance (it is the editor's DISPLAY name for the same kind).
    if (kind.type !== "Comp" && kind.type !== "Composition") continue;
    const width = positiveInt(kind.width);
    const height = positiveInt(kind.height);
    const duration = positiveNumber(kind.duration);
    const rate = asRecord(kind.frame_rate) ?? asRecord(kind.frameRate);
    const fps =
      rate !== null && positiveNumber(rate.num) !== null
        ? Number(rate.num) / (positiveNumber(rate.den) ?? 1)
        : positiveNumber(kind.frameRate);
    if (width === null || height === null || duration === null || fps === null) continue;
    return { durationSeconds: duration / EC_TICKS_PER_SECOND, width, height, frameRate: fps };
  }
  return null;
}

/**
 * Tolerance fallback for the synthetic/legacy `compositions: []` shape used by
 * older fixtures: durations/fps in SECONDS/Hz, ids/names as strings.
 */
function compFromCompositions(root: Record<string, unknown>, compId: string): CompMeta | null {
  if (!Array.isArray(root.compositions)) return null;
  for (const raw of root.compositions) {
    const comp = asRecord(raw);
    if (comp === null) continue;
    const idMatches = comp.id !== undefined && String(comp.id) === compId;
    const nameMatches = typeof comp.name === "string" && comp.name === compId;
    if (!idMatches && !nameMatches) continue;
    const width = positiveInt(comp.width);
    const height = positiveInt(comp.height);
    const duration = positiveNumber(comp.durationSeconds) ?? positiveNumber(comp.duration);
    const fps = positiveNumber(comp.frameRate);
    if (width === null || height === null || duration === null || fps === null) continue;
    return { durationSeconds: duration, width, height, frameRate: fps };
  }
  return null;
}

/** Locate the requested comp inside a parsed .ecproj, or null. */
function findComp(ecproj: unknown, compId: string): CompMeta | null {
  const root = asRecord(ecproj);
  if (root === null) return null;
  return compFromItems(root.items, compId) ?? compFromCompositions(root, compId);
}

// ---------------------------------------------------------------------------
// The shared queue/estimate computation (one derivation, no drift)
// ---------------------------------------------------------------------------

/** Normalized view of a render request the queue and the estimate share. */
interface RenderQuote {
  readonly project: Project;
  /** The pinned version — ALWAYS the project head, never client-supplied. */
  readonly versionId: string;
  readonly outputSeconds: number;
  readonly longEdgePx: number;
  readonly quality: RenderQualityId;
  /**
   * The settings stored on the row: the client's settings plus the server's
   * materialized effective frameRate (settings.frameRate ?? the comp's —
   * renderSecondsUsed reads it for the monthly-minutes accounting) and the
   * range clamped to the comp timeline (price == stored == rendered).
   */
  readonly storedSettings: Record<string, unknown>;
}

/**
 * Resolve a queue/estimate request against the project's PINNED version: load
 * the project (tenant-scoped — cross-tenant ids are 404s), read the head
 * version's .ecproj bytes from storage, and derive duration/size/fps/quality
 * from the actual comp metadata. Shared by BOTH routes so the estimate and
 * the reserve can never disagree.
 */
async function resolveRenderQuote(
  deps: GatewayDeps,
  workspaceId: string,
  requestId: string,
  input: { readonly projectId: string; readonly compId: string },
  settings: {
    readonly timeFrom?: number;
    readonly timeTo?: number;
    readonly width?: number;
    readonly height?: number;
    readonly frameRate?: number;
    readonly quality?: RenderQualityId;
  },
): Promise<RenderQuote> {
  const project = await deps.repos.projects.get(workspaceId, input.projectId);
  if (project.currentVersionId === null) {
    // A project with no versions has nothing renderable (§9.3).
    throw new StudioError("RENDER_PROJECT_INVALID", {
      message: "This project can't be rendered as-is.",
      hint: "Save a version of the project first, then render.",
      requestId,
    });
  }
  const versionId = project.currentVersionId; // SERVER-pinned, §9.3
  const version = await deps.repos.versions.get(workspaceId, project.id, versionId);

  const bytes = await deps.storage.read(version.objectKey);
  if (bytes === null) {
    // The version bytes are missing from storage — an infrastructure fault,
    // never the client's project. (LocalFS serves reads; the S3 driver's
    // read() is a documented null — S3 estimate/queue pricing needs a
    // signed-URL fetch seam, flagged to the worker wave.)
    throw new StudioError("RENDER_INTERNAL", { requestId });
  }
  let ecproj: unknown;
  try {
    ecproj = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    // The stored snapshot is not valid JSON — the project cannot be rendered
    // as-is (the upload only ever verified its sha256, not its schema).
    throw new StudioError("RENDER_PROJECT_INVALID", {
      message: "This project can't be rendered as-is.",
      hint: "Re-save the project from the editor and try again.",
      requestId,
    });
  }
  const comp = findComp(ecproj, input.compId);
  if (comp === null) {
    throw new StudioError("RENDER_PROJECT_INVALID", {
      message: "This project can't be rendered as-is.",
      hint: "The requested composition is not in this version of the project.",
      requestId,
    });
  }

  // Effective output size: settings override the comp's native size one axis
  // at a time; the long edge is what the pricing tiers (and the plan cap) use.
  const width = settings.width ?? comp.width;
  const height = settings.height ?? comp.height;
  const longEdgePx = Math.max(width, height);

  // Effective frame rate for the ROW (the monthly-minutes accounting reads
  // settingsJson.frameRate — materializing the comp's native fps keeps the
  // usage sum honest when the client omits one).
  const frameRate = settings.frameRate ?? comp.frameRate;

  // Range: the comp timeline is the bound — an out-point beyond the duration
  // is clamped so the priced range, the STORED range and the worker's range
  // are the same seconds. An in-point at/past the duration is refused by
  // renderOutputSeconds (empty range) as VALIDATION_FAILED.
  const clampedTo =
    settings.timeTo !== undefined ? Math.min(settings.timeTo, comp.durationSeconds) : undefined;
  const outputSeconds = renderOutputSeconds({
    durationSeconds: comp.durationSeconds,
    timeFrom: settings.timeFrom,
    timeTo: clampedTo,
  });

  return {
    project,
    versionId,
    outputSeconds,
    longEdgePx,
    quality: settings.quality ?? "good",
    storedSettings: {
      ...settings,
      frameRate,
      ...(clampedTo !== undefined ? { timeTo: clampedTo } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// The monthly render-minutes window (the billing convention, cited)
// ---------------------------------------------------------------------------

/**
 * The render-minutes billing window starts at the FIRST INSTANT of the
 * current UTC month. CONVENTION CITATION (M8-G): no gateway billing surface
 * computes a period START — GET /v1/billing/state reports only
 * `currentPeriodEnd` (the Stripe anchor), the credits reconciliation window
 * takes EXPLICIT caller-supplied bounds, and the subscriptions row persists
 * `currentPeriodEnd` only — there is no stored period start, and trial
 * workspaces (no subscription row at all) gate on the trial catalog tier
 * through resolvePlan. The catalog says "render minutes per billing month",
 * so the derivable, workspace-uniform window is the UTC calendar month.
 * If a later billing wave anchors windows to the Stripe period, swap this
 * ONE helper (and the renderSecondsUsed call site) — nothing else changes.
 */
function utcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

export function rendersRoutes(deps: GatewayDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("/v1/renders/*", requireAuth());

  const toJob = async (render: Render): Promise<RenderJob> => {
    let resultUrl: string | null = null;
    // Signed download ONLY while the artifact exists: completed + objectKey
    // present. Retention-expired rows have objectKey cleared (M8-A
    // markOutputExpired) → resultUrl null, the row stays as history.
    if (render.status === "completed" && render.objectKey !== null) {
      const signed = await deps.storage.getSignedUrl(render.objectKey, SIGNED_URL_TTL_SECONDS, {
        method: "GET",
      });
      resultUrl = signed.url;
    }
    // D-11: the DB status vocabulary IS the wire vocabulary — completed, not
    // "succeeded"; the v1 completed→succeeded mapping is gone.
    const framesDone = render.framesDone;
    const framesTotal = render.framesTotal;
    const percent =
      framesTotal > 0 ? Math.min(100, Math.floor((framesDone * 100) / framesTotal)) : 0;
    return {
      id: render.id,
      projectId: render.projectId,
      compId: render.compId,
      versionId: render.versionId,
      format: (RENDER_FORMATS as readonly string[]).includes(render.format)
        ? (render.format as RenderJob["format"])
        : "mp4", // unreachable: the queue only admits declared formats
      settings: (render.settingsJson as Record<string, unknown> | null) ?? {},
      status: render.status as RenderJob["status"],
      cancelRequested: render.cancelRequested,
      progress: { framesDone, framesTotal, percent },
      // renders.credits is INTEGER µc (see the module header) → the D-12
      // 2-decimal display number at this boundary; null until priced.
      credits: render.credits > 0 ? microcreditsToDisplayCredits(render.credits) : null,
      resultUrl,
      errorCode: render.errorCode,
      error: render.error,
      sizeBytes: render.sizeBytes,
      createdBy: render.createdBy,
      createdAt: render.createdAt.toISOString(),
      startedAt: render.startedAt !== null ? render.startedAt.toISOString() : null,
      completedAt: render.completedAt !== null ? render.completedAt.toISOString() : null,
      expiresAt: render.expiresAt !== null ? render.expiresAt.toISOString() : null,
    };
  };

  // ── POST /v1/renders — queue (editor) ─────────────────────────────────────
  app.post("/v1/renders", requireWorkspace("editor"), async (c: AppContext): Promise<Response> => {
    const requestId = c.get("requestId");
    const workspace = c.get("workspace");

    const parsed = QUEUE_RENDER_SCHEMA.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new StudioError("VALIDATION_FAILED", { requestId });
    }
    const request = parsed.data;

    // The comp metadata comes from the PINNED version — priced BEFORE any
    // gate so every entitlement check sees the real output (and so the
    // estimate route, which reuses this derivation, agrees exactly).
    const quote = await resolveRenderQuote(
      deps,
      workspace.id,
      requestId,
      request,
      request.settings,
    );

    // Entitlement gates, in order — each a typed StudioError (plan comes from
    // the workspace's subscription row via the resolvePlan seam; entitlements
    // from the catalog, never inlined).
    const plan = await resolvePlan(workspace.id, {
      admin: isAdminRole(c.get("auth").user.role),
    });
    const entitlements = entitlementsFor(plan);

    // (a) D-2: only MP4 + PNG sequence are enabled in v1; the other declared
    // formats stay priced but refused at queue time.
    if (!isRenderFormatEnabled(request.format)) {
      throw new StudioError("RENDER_UNSUPPORTED_FORMAT", { requestId });
    }

    // (b) The resolution cap. PINNED MAPPING (M8-G): the config catalog
    // documents RENDER_QUOTA_EXCEEDED (429) as the MONTHLY-MINUTES gate only
    // ("workspace out of render minutes this cycle", M8-B) — it says nothing
    // about a resolution cap, and the cap is validation-shaped (fix the
    // request, not the plan), so it maps to VALIDATION_FAILED. Status pinned
    // at 422 (Unprocessable Content): the payload is schema-valid but
    // semantically over the plan's maxRenderLongEdgePx, and the house's 400
    // stays reserved for boundary/schema failures. The row below overrides
    // the STATUS_BY_CODE 400 for this one gate only.
    if (quote.longEdgePx > entitlements.maxRenderLongEdgePx) {
      throw new GatewayError(
        "VALIDATION_FAILED",
        "That render size is larger than your plan allows.",
        {
          status: 422,
          hint: `Renders are capped at a ${entitlements.maxRenderLongEdgePx}px long edge on this plan. Lower the resolution or upgrade.`,
          requestId,
        },
      );
    }

    // (c) Concurrency: queued + running rows against maxConcurrentRenders.
    const active = await deps.repos.renders.countActive(workspace.id);
    if (active >= entitlements.maxConcurrentRenders) {
      throw new StudioError("RENDER_CONCURRENCY_LIMIT", { requestId });
    }

    // (d) Monthly render minutes: Σ completed output seconds this billing
    // month (renderSecondsUsed — the honest fallback is 0 for rows without a
    // usable frameRate) against renderMinutesPerMonth, via the catalog helper
    // so the threshold can never drift. The requested render must FIT the
    // remaining minutes: renders are charged per output second and no partial
    // policy is documented, so a job whose full output exceeds the remainder
    // is refused up-front (a fully-used quota is the remaining === 0 case).
    const windowStart = utcMonthStart(new Date());
    const secondsUsed = await deps.repos.renders.renderSecondsUsed(workspace.id, windowStart);
    const remainingMinutes = renderMinutesRemaining(plan, secondsUsed / 60);
    if (quote.outputSeconds > remainingMinutes * 60) {
      throw new StudioError("RENDER_QUOTA_EXCEEDED", { requestId });
    }

    // (e) Credits: the ONE formula's µc — the exact hold this route takes and
    // the worker later settles. §8.8: refuse on a balance that cannot cover
    // the hold BEFORE any row exists (INSUFFICIENT_CREDITS 402, no ledger row).
    const detail = estimateRenderCostDetailUc({
      format: request.format,
      outputSeconds: quote.outputSeconds,
      longEdgePx: quote.longEdgePx,
      quality: quote.quality,
    });
    const balance = await deps.repos.ledger.balance(workspace.id);
    if (balance < detail.totalUc) {
      throw new StudioError("INSUFFICIENT_CREDITS", { requestId });
    }

    // (f)+(g) Create the row FIRST — it is the idempotency anchor and the
    // ledger scope needs its id. versionId is the SERVER-pinned project head
    // (never client-supplied — the body schema rejects a versionId outright);
    // objectKey is pre-created at queue time with the `{renderId}` placeholder
    // so the worker never guesses §9.2 layout (repos/renders.ts resolves it
    // against the generated id); credits stores the integer µc cost (the
    // column dialect — module header), so the wire display and the ledger
    // hold below are the same number.
    const objectKey = renderKey(
      workspace.id,
      quote.project.id,
      "{renderId}",
      request.format === "png-seq" ? "zip" : "mp4",
    );
    const render = await deps.repos.renders.create(workspace.id, {
      projectId: quote.project.id,
      versionId: quote.versionId,
      compId: request.compId,
      format: request.format,
      settingsJson: quote.storedSettings,
      credits: detail.totalUc,
      createdBy: c.get("auth").user.id,
      objectKey,
    });

    // (h) Hold the credits, scoped to the render. A refusal (the balance can
    // dip between the precheck and the hold — a rare race) must never orphan
    // the queued row for a worker to claim an UNPAID job: terminal-fail it
    // with error_code RENDER_INTERNAL and surface the original typed error
    // (402 INSUFFICIENT_CREDITS / 500) to the caller.
    try {
      await deps.repos.ledger.reserve(workspace.id, {
        renderId: render.id,
        amount: detail.totalUc,
        idempotencyKey: `render:reserve:${render.id}`,
        metadata: {
          versionId: quote.versionId,
          format: request.format,
          outputSeconds: quote.outputSeconds,
          longEdgePx: quote.longEdgePx,
          quality: quote.quality,
        },
      });
    } catch (error) {
      // NOTE (M8-G finding): the RENDER status machine (packages/db
      // statuses.ts, M8-A) has no queued→failed carve-out — unlike the RUN
      // machine's F-J5 row — so markFailed on the fresh queued row would
      // CONFLICT. The legal path to the same terminal state is the two-step
      // queued→running→failed below (the intermediate running is unobservable
      // — this single request terminal-fails before any claim or stale sweep
      // can see it; claimNext only takes queued rows). Follow-up for the db
      // owner: add "failed" to RENDER_TRANSITIONS.queued and simplify this to
      // one markFailed call.
      try {
        await deps.repos.renders.markRunning(workspace.id, render.id);
        await deps.repos.renders.markFailed(workspace.id, render.id, {
          error: "Could not hold the credits for this render.",
          errorCode: "RENDER_INTERNAL",
        });
      } catch (cleanupError) {
        deps.logger.error("render_reserve_cleanup_failed", {
          requestId,
          renderId: render.id,
          detail: cleanupError instanceof Error ? cleanupError.message : "unknown",
        });
      }
      throw error;
    }

    await audit(deps, c, workspace.id, "render.queued", quote.project.id, {
      // The audit TARGET is the project (the activity feed resolves
      // project-targeted rows by targetId — a render id would never match);
      // the render rides metadata.
      renderId: render.id,
      versionId: quote.versionId,
      format: request.format,
      objectKey: render.objectKey,
      outputSeconds: quote.outputSeconds,
      longEdgePx: quote.longEdgePx,
    });

    return ok(c, await toJob(render), 201);
  });

  // ── POST /v1/renders/estimate — a PURE read (viewer) ──────────────────────
  //
  // IDEMPOTENCY_EXCLUDED (middleware.ts): no Idempotency-Key header, no body
  // key, NO side effects — no row, no ledger hold, no gate that writes. The
  // numbers are derived by the SAME shared computation as the queue route, so
  // the quote the dialog shows is exactly what the queue reserves (the M8-B
  // one-formula identity; pinned by tests).
  app.post(
    "/v1/renders/estimate",
    requireWorkspace("viewer"),
    async (c: AppContext): Promise<Response> => {
      const requestId = c.get("requestId");
      const workspace = c.get("workspace");

      const parsed = RENDER_ESTIMATE_REQUEST_SCHEMA.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        throw new StudioError("VALIDATION_FAILED", { requestId });
      }
      const request = parsed.data;

      const quote = await resolveRenderQuote(
        deps,
        workspace.id,
        requestId,
        request,
        request.settings,
      );
      // Pricing covers every DECLARED format (D-2 reserved formats stay
      // priced for completeness); the queue refuses the disabled ones.
      const detail = estimateRenderCostDetailUc({
        format: request.format,
        outputSeconds: quote.outputSeconds,
        longEdgePx: quote.longEdgePx,
        quality: quote.quality,
      });

      const body: EstimateResult = {
        // D-12 display number — µc never crosses the wire.
        credits: microcreditsToDisplayCredits(detail.totalUc),
        outputSeconds: quote.outputSeconds,
        longEdgePx: quote.longEdgePx,
        format: request.format,
        quality: quote.quality,
        minApplied: detail.minApplied,
      };
      return ok(c, body);
    },
  );

  // ── GET /v1/renders — history (viewer) ────────────────────────────────────
  app.get("/v1/renders", requireWorkspace("viewer"), async (c: AppContext): Promise<Response> => {
    const parsed = RENDERS_QUERY_SCHEMA.safeParse({
      cursor: c.req.query("cursor"),
      limit: c.req.query("limit"),
      projectId: c.req.query("projectId") ?? undefined,
      status: c.req.query("status") ?? undefined,
    });
    if (!parsed.success) {
      throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
        status: 400,
        hint: "Check the filters (projectId, status) and the pagination parameters.",
        requestId: c.get("requestId"),
      });
    }
    const result = await deps.repos.renders.list(c.get("workspace").id, {
      projectId: parsed.data.projectId,
      status: parsed.data.status,
      cursor: parsed.data.cursor ?? null,
      limit: parsed.data.limit,
    });
    const jobs = await Promise.all(result.items.map(toJob));
    return page(c, jobs, result.nextCursor);
  });

  // ── GET /v1/renders/:id — one job (viewer) ─────────────────────────────────
  app.get(
    "/v1/renders/:id",
    requireWorkspace("viewer"),
    async (c: AppContext): Promise<Response> => {
      const render = await deps.repos.renders.get(c.get("workspace").id, pathParam(c, "id"));
      return ok(c, await toJob(render));
    },
  );

  // ── POST /v1/renders/:id/cancel — cooperative cancel (editor) ─────────────
  //
  // The repo only RAISES the cancel_requested flag: a queued row keeps its
  // status and is skipped at claim time; a running row is observed by its
  // worker (M8-F), which terminal-transitions it and refunds the reserve.
  // Terminal rows → the repo's typed CONFLICT (409). The Idempotency-Key
  // HEADER is enforced by the global POST middleware; the body is an optional
  // human-safe reason.
  app.post(
    "/v1/renders/:id/cancel",
    requireWorkspace("editor"),
    async (c: AppContext): Promise<Response> => {
      const workspace = c.get("workspace");
      const parsed = CANCEL_RENDER_SCHEMA.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) {
        throw new StudioError("VALIDATION_FAILED", { requestId: c.get("requestId") });
      }
      const render = await deps.repos.renders.requestCancel(workspace.id, pathParam(c, "id"));
      await audit(deps, c, workspace.id, "render.cancel_requested", render.projectId, {
        renderId: render.id,
        reason: parsed.data.reason ?? null,
      });
      return ok(c, await toJob(render));
    },
  );

  return app;
}
