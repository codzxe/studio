import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { clampLimit, decodeCursor, encodeCursor } from "../cursor.js";
import { DbError } from "../errors-lite.js";
import { createId } from "../ids.js";
import { projectVersions, projects, renders } from "../schema.js";
import { assertRenderTransition } from "../statuses.js";
import { requireNonEmpty, requireNonNegativeInt, requirePositiveInt, } from "./shared.js";
/** The placeholder token create() substitutes with the freshly generated id. */
const RENDER_ID_PLACEHOLDER = "{renderId}";
/** Resolves the route-precreated §9.2 key against the generated row id. */
function resolveObjectKey(template, renderId) {
    if (template === undefined)
        return null;
    const key = requireNonEmpty(template, "objectKey");
    return key.includes(RENDER_ID_PLACEHOLDER)
        ? key.replaceAll(RENDER_ID_PLACEHOLDER, renderId)
        : key;
}
/** Upper bound for a single claim batch — a worker must never hog the queue. */
const MAX_CLAIM_LIMIT = 25;
/** frameRate from settingsJson (RENDER_SETTINGS_SCHEMA.frameRate); null if absent/invalid. */
function frameRateOf(settings) {
    if (typeof settings !== "object" || settings === null)
        return null;
    const fps = settings.frameRate;
    return typeof fps === "number" && Number.isFinite(fps) && fps > 0 ? fps : null;
}
function requireValidDate(value, field) {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
        throw DbError.validation(`${field} must be a valid Date`);
    }
    return value;
}
export function createRendersRepo(db) {
    async function requireRender(workspaceId, renderId) {
        const [row] = await db
            .select({ render: renders })
            .from(renders)
            .innerJoin(projects, eq(renders.projectId, projects.id))
            .where(and(eq(renders.id, renderId), eq(projects.workspaceId, workspaceId)))
            .limit(1);
        if (!row)
            throw DbError.notFound("render");
        return row.render;
    }
    async function transition(workspaceId, renderId, to, extra) {
        const render = await requireRender(workspaceId, renderId);
        assertRenderTransition(render.status, to);
        const [updated] = await db
            .update(renders)
            .set({ status: to, ...extra })
            .where(and(eq(renders.id, render.id), eq(renders.status, render.status)))
            .returning();
        if (!updated)
            throw DbError.conflict("Render state changed concurrently");
        return updated;
    }
    return {
        async create(workspaceId, input) {
            const compId = requireNonEmpty(input.compId, "compId");
            const format = requireNonEmpty(input.format, "format");
            const versionId = requireNonEmpty(input.versionId, "versionId");
            requireNonEmpty(input.createdBy, "createdBy");
            requireNonNegativeInt(input.credits ?? 0, "credits");
            const [project] = await db
                .select({ id: projects.id })
                .from(projects)
                .where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, workspaceId)))
                .limit(1);
            if (!project)
                throw DbError.notFound("project");
            // The pinned version must belong to the SAME project (§9.3) — a version
            // of another project (or another tenant's, or unknown) reads as 404.
            const [version] = await db
                .select({ id: projectVersions.id })
                .from(projectVersions)
                .where(and(eq(projectVersions.id, versionId), eq(projectVersions.projectId, project.id)))
                .limit(1);
            if (!version)
                throw DbError.notFound("version");
            // The id is generated here so the M8-G objectKey template can resolve
            // against it (see RenderCreateInput.objectKey).
            const renderId = createId("rdr");
            const [render] = await db
                .insert(renders)
                .values({
                id: renderId,
                projectId: project.id,
                versionId: version.id,
                compId,
                format,
                settingsJson: input.settingsJson,
                status: "queued",
                credits: input.credits ?? 0,
                createdBy: input.createdBy,
                // M8-G: the route-precreated §9.2 output key (queue-time, so the
                // worker never guesses layout); NULL when the caller omits it.
                objectKey: resolveObjectKey(input.objectKey, renderId),
                // Job-queue defaults come from the DB (migration 0005):
                // attempts=0, frames_done=0, frames_total=0, cancel_requested=false.
            })
                .returning();
            if (!render)
                throw DbError.conflict("Could not queue render");
            return render;
        },
        markRunning: (workspaceId, renderId) => transition(workspaceId, renderId, "running", {}),
        markCompleted: (workspaceId, renderId, result) => {
            const objectKey = requireNonEmpty(result.objectKey, "objectKey");
            const extra = {
                objectKey,
                completedAt: new Date(),
            };
            if (result.sizeBytes !== undefined) {
                extra.sizeBytes = requireNonNegativeInt(result.sizeBytes, "sizeBytes");
            }
            if (result.expiresAt !== undefined) {
                extra.expiresAt = requireValidDate(result.expiresAt, "expiresAt");
            }
            return transition(workspaceId, renderId, "completed", extra);
        },
        markFailed: (workspaceId, renderId, result) => {
            const error = requireNonEmpty(result.error, "error");
            return transition(workspaceId, renderId, "failed", {
                error,
                errorCode: result.errorCode ?? null,
                completedAt: new Date(),
            });
        },
        markCancelled: (workspaceId, renderId) => transition(workspaceId, renderId, "cancelled", { completedAt: new Date() }),
        async get(workspaceId, renderId) {
            return requireRender(workspaceId, renderId);
        },
        async list(workspaceId, options) {
            const limit = clampLimit(options?.limit);
            const cursor = decodeCursor(options?.cursor ?? null);
            const rows = await db
                .select({ render: renders })
                .from(renders)
                .innerJoin(projects, eq(renders.projectId, projects.id))
                .where(and(eq(projects.workspaceId, workspaceId), options?.projectId === undefined ? undefined : eq(renders.projectId, options.projectId), options?.status === undefined ? undefined : eq(renders.status, options.status), cursor
                ? or(lt(renders.createdAt, new Date(cursor.t)), and(eq(renders.createdAt, new Date(cursor.t)), lt(renders.id, cursor.id)))
                : undefined))
                .orderBy(desc(renders.createdAt), desc(renders.id))
                .limit(limit + 1);
            const items = rows.map((row) => row.render).slice(0, limit);
            const last = items.at(-1);
            const hasMore = rows.length > limit;
            return {
                items,
                nextCursor: hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null,
            };
        },
        async claimNext(workerId, options) {
            // workerId is required for call-site auditability (each claim is
            // attributable in logs/metrics); the M8-A column set intentionally
            // does not persist a claimer id — liveness is heartbeat-scoped.
            requireNonEmpty(workerId, "workerId");
            const limit = options?.limit === undefined
                ? 1
                : Math.min(requirePositiveInt(options.limit, "limit"), MAX_CLAIM_LIMIT);
            return db.transaction(async (tx) => {
                // SELECT … FOR UPDATE SKIP LOCKED: concurrent workers never block each
                // other or double-claim — locked rows are simply skipped.
                const queued = await tx
                    .select({ id: renders.id })
                    .from(renders)
                    .where(and(eq(renders.status, "queued"), eq(renders.cancelRequested, false)))
                    .orderBy(asc(renders.createdAt), asc(renders.id))
                    .limit(limit)
                    .for("update", { skipLocked: true });
                if (queued.length === 0)
                    return [];
                const now = new Date();
                const claimed = await tx
                    .update(renders)
                    .set({
                    status: "running",
                    startedAt: now,
                    heartbeatAt: now,
                    attempts: sql `${renders.attempts} + 1`,
                })
                    // queued → running is a legal public transition; the rows are locked
                    // by this transaction, so the status guard cannot race.
                    .where(and(inArray(renders.id, queued.map((row) => row.id)), eq(renders.status, "queued")))
                    .returning();
                if (claimed.length === 0)
                    return [];
                // Resolve workspaceId per row (renders scope through projects) so the
                // worker can make workspace-first calls for everything else. Returned
                // in claim (FIFO) order.
                const scoped = await tx
                    .select({ render: renders, workspaceId: projects.workspaceId })
                    .from(renders)
                    .innerJoin(projects, eq(renders.projectId, projects.id))
                    .where(inArray(renders.id, claimed.map((row) => row.id)))
                    .orderBy(asc(renders.createdAt), asc(renders.id));
                return scoped.map((row) => ({ ...row.render, workspaceId: row.workspaceId }));
            });
        },
        async heartbeat(workspaceId, renderId, progress) {
            const framesDone = progress?.framesDone === undefined
                ? undefined
                : requireNonNegativeInt(progress.framesDone, "framesDone");
            const framesTotal = progress?.framesTotal === undefined
                ? undefined
                : requireNonNegativeInt(progress.framesTotal, "framesTotal");
            const render = await requireRender(workspaceId, renderId);
            if (render.status !== "running") {
                throw DbError.conflict(`Cannot heartbeat a ${render.status} render`);
            }
            // Monotonic frames: greatest(col, value) — a late/duplicate ping can
            // never rewind progress. Idempotent: re-sending the same values is a no-op
            // apart from the heartbeat_at bump.
            const [updated] = await db
                .update(renders)
                .set({
                heartbeatAt: new Date(),
                ...(framesDone === undefined
                    ? {}
                    : { framesDone: sql `greatest(${renders.framesDone}, ${framesDone})` }),
                ...(framesTotal === undefined
                    ? {}
                    : { framesTotal: sql `greatest(${renders.framesTotal}, ${framesTotal})` }),
            })
                .where(and(eq(renders.id, render.id), eq(renders.status, "running")))
                .returning();
            if (!updated)
                throw DbError.conflict("Render state changed concurrently");
            return updated;
        },
        async requestCancel(workspaceId, renderId) {
            const render = await requireRender(workspaceId, renderId);
            if (render.status !== "queued" && render.status !== "running") {
                throw DbError.conflict(`Cannot cancel a ${render.status} render`);
            }
            if (render.cancelRequested)
                return render; // idempotent while still cancelable
            const [updated] = await db
                .update(renders)
                .set({ cancelRequested: true })
                .where(and(eq(renders.id, render.id), inArray(renders.status, ["queued", "running"])))
                .returning();
            if (!updated)
                throw DbError.conflict("Render state changed concurrently");
            return updated;
        },
        async requeueStale(staleSeconds, maxAttempts) {
            requirePositiveInt(staleSeconds, "staleSeconds");
            requirePositiveInt(maxAttempts, "maxAttempts");
            const cutoff = new Date(Date.now() - staleSeconds * 1000);
            // Stale = running with no heartbeat at all, or one older than the cutoff.
            const stale = and(eq(renders.status, "running"), or(isNull(renders.heartbeatAt), lt(renders.heartbeatAt, cutoff)));
            // Branch 1: attempts left → back to queued. This is the ONLY sanctioned
            // running→queued transition (statuses.ts); cancel_requested is reset so
            // a fresh claim is possible (the previous attempt's cancel died with it).
            const requeued = await db
                .update(renders)
                .set({ status: "queued", cancelRequested: false, startedAt: null, heartbeatAt: null })
                .where(and(stale, lt(renders.attempts, maxAttempts)))
                .returning({ id: renders.id });
            // Branch 2: out of attempts → honest terminal failure.
            const failed = await db
                .update(renders)
                .set({
                status: "failed",
                error: "worker lost mid-render",
                errorCode: "RENDER_INTERNAL",
                completedAt: new Date(),
            })
                .where(and(stale, gte(renders.attempts, maxAttempts)))
                .returning({ id: renders.id });
            return requeued.length + failed.length;
        },
        async listExpiredOutputs(before) {
            requireValidDate(before, "before");
            const rows = await db
                .select({ render: renders, workspaceId: projects.workspaceId })
                .from(renders)
                .innerJoin(projects, eq(renders.projectId, projects.id))
                // lt() alone excludes expires_at IS NULL rows (SQL NULL semantics).
                .where(and(eq(renders.status, "completed"), lt(renders.expiresAt, before)))
                .orderBy(asc(renders.expiresAt), asc(renders.id));
            return rows.map((row) => ({ ...row.render, workspaceId: row.workspaceId }));
        },
        async markOutputExpired(workspaceId, renderId) {
            const render = await requireRender(workspaceId, renderId);
            if (render.status !== "completed") {
                throw DbError.conflict("Only completed renders have an expirable output");
            }
            if (render.objectKey === null)
                return render; // already expired — idempotent
            const [updated] = await db
                .update(renders)
                .set({ objectKey: null, expiresAt: null, sizeBytes: null })
                .where(and(eq(renders.id, render.id), eq(renders.status, "completed")))
                .returning();
            if (!updated)
                throw DbError.conflict("Render state changed concurrently");
            return updated;
        },
        async renderSecondsUsed(workspaceId, since) {
            requireValidDate(since, "since");
            const rows = await db
                .select({ framesTotal: renders.framesTotal, settingsJson: renders.settingsJson })
                .from(renders)
                .innerJoin(projects, eq(renders.projectId, projects.id))
                .where(and(eq(projects.workspaceId, workspaceId), eq(renders.status, "completed"), gte(renders.completedAt, since)));
            let seconds = 0;
            for (const row of rows) {
                const fps = frameRateOf(row.settingsJson);
                // Honest fallback (documented): without a usable frameRate or frames
                // the row contributes 0 — never a guess.
                if (fps === null || row.framesTotal <= 0)
                    continue;
                seconds += row.framesTotal / fps;
            }
            return seconds;
        },
        async countActive(workspaceId) {
            const [row] = await db
                .select({ total: sql `count(*)::int` })
                .from(renders)
                .innerJoin(projects, eq(renders.projectId, projects.id))
                .where(and(eq(projects.workspaceId, workspaceId), inArray(renders.status, ["queued", "running"])));
            return row?.total ?? 0;
        },
    };
}
//# sourceMappingURL=renders.js.map