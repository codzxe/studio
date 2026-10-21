// @studio/gateway — /v1/renders (§7.2, §9.1): queue + status.
//
// POST enqueues through the renders repo (status queued) and hands the job
// to a RenderWorker seam — v1 ships the Noop worker (the queue/worker wave
// replaces it behind the same interface; TODO(W4/worker)).

import { Hono } from "hono";

import { QUEUE_RENDER_SCHEMA, type RenderJob } from "@studio/contracts";
import { StudioError } from "@studio/config";

import { ok, pathParam } from "../http.js";
import { requireAuth, requireWorkspace } from "../middleware.js";
import { SIGNED_URL_TTL_SECONDS } from "../signing.js";
import { renderKey } from "../storage.js";
import { audit } from "./projects.js";
import type { AppBindings, AppContext, GatewayDeps } from "../context.js";
import type { Render } from "@studio/db";

/** Worker seam (§5): a later wave binds this to Valkey/BullMQ. */
export interface RenderWorker {
  enqueue(render: { id: string; projectId: string }): Promise<void>;
}

export function createNoopRenderWorker(logger: { warn(msg: string, fields?: Record<string, unknown>): void }): RenderWorker {
  return {
    async enqueue(render) {
      logger.warn("render_worker_noop", { renderId: render.id, hint: "No render worker is wired in W2-b; the job stays queued." });
    },
  };
}

export function rendersRoutes(deps: GatewayDeps, worker: RenderWorker = createNoopRenderWorker(deps.logger)): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("/v1/renders/*", requireAuth());

  const toJob = async (render: Render): Promise<RenderJob> => {
    let resultUrl: string | null = null;
    if (render.status === "completed" && render.objectKey !== null) {
      const signed = await deps.storage.getSignedUrl(render.objectKey, SIGNED_URL_TTL_SECONDS, { method: "GET" });
      resultUrl = signed.url;
    }
    return {
      id: render.id,
      projectId: render.projectId,
      compId: render.compId,
      format: (["mp4", "prores", "png-seq", "gif", "wav"] as const).includes(render.format as never)
        ? (render.format as RenderJob["format"])
        : "mp4",
      settings: (render.settingsJson as Record<string, unknown> | null) ?? {},
      // Wire: "succeeded" (contracts) ← db: "completed".
      status: render.status === "completed" ? "succeeded" : (render.status as RenderJob["status"]),
      credits: render.credits,
      resultUrl,
      error: render.error,
      createdBy: render.createdBy,
      createdAt: render.createdAt.toISOString(),
      completedAt: render.completedAt !== null ? render.completedAt.toISOString() : null,
    };
  };

  app.post("/v1/renders", requireWorkspace("editor"), async (c: AppContext): Promise<Response> => {
    const workspace = c.get("workspace");
    const parsed = QUEUE_RENDER_SCHEMA.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new StudioError("VALIDATION_FAILED", { requestId: c.get("requestId") });
    }
    const render = await deps.repos.renders.create(workspace.id, {
      projectId: parsed.data.projectId,
      compId: parsed.data.compId,
      format: parsed.data.format,
      settingsJson: parsed.data.settings,
      credits: 0,
      createdBy: c.get("auth").user.id,
    });
    // Pre-create the §9.2 output key so the worker never guesses layout.
    const objectKey = renderKey(workspace.id, parsed.data.projectId, render.id, parsed.data.format);
    await worker.enqueue({ id: render.id, projectId: parsed.data.projectId });
    await audit(deps, c, workspace.id, "render.queued", render.id, { objectKey });
    const job = await toJob(render);
    return ok(c, job, 201);
  });

  app.get("/v1/renders/:id", requireWorkspace("viewer"), async (c: AppContext): Promise<Response> => {
    const render = await deps.repos.renders.get(c.get("workspace").id, pathParam(c, "id"));
    return ok(c, await toJob(render));
  });

  return app;
}
