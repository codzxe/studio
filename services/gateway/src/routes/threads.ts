// @studio/gateway — chat threads + messages (§7.2, §9.1).

import { Hono } from "hono";

import {
  CREATE_THREAD_SCHEMA,
  PAGINATION_QUERY_SCHEMA,
  type Thread as ThreadDto,
  type ThreadMessage,
} from "@studio/contracts";

import type { AgentMessage, AgentThread } from "@studio/db";
import type { AppBindings, AppContext, GatewayDeps } from "../context.js";
import { GatewayError } from "../errors.js";
import { ok, page, pathParam } from "../http.js";
import { requireAuth, requireWorkspace } from "../middleware.js";

export function threadsRoutes(deps: GatewayDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("/v1/projects/*", requireAuth());
  app.use("/v1/threads/*", requireAuth());

  const toThreadDto = (thread: AgentThread): ThreadDto => ({
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    createdBy: thread.createdBy,
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
  });

  const toMessageDto = (message: AgentMessage): ThreadMessage => ({
    id: message.id,
    threadId: message.threadId,
    role: message.role === "assistant" || message.role === "system" ? message.role : "user",
    content: message.contentJson,
    runId: message.runId,
    createdAt: message.createdAt.toISOString(),
  });

  app.get(
    "/v1/projects/:id/threads",
    requireWorkspace("viewer"),
    async (c: AppContext): Promise<Response> => {
      const query = PAGINATION_QUERY_SCHEMA.safeParse({
        cursor: c.req.query("cursor"),
        limit: c.req.query("limit"),
      });
      if (!query.success) {
        throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
          status: 400,
          hint: "Check the pagination parameters.",
          requestId: c.get("requestId"),
        });
      }
      const workspaceId = c.get("workspace").id;
      const result = await deps.repos.threads.listByProject(workspaceId, pathParam(c, "id"), {
        cursor: query.data.cursor ?? null,
        limit: query.data.limit,
      });
      return page(c, result.items.map(toThreadDto), result.nextCursor);
    },
  );

  app.post(
    "/v1/projects/:id/threads",
    requireWorkspace("editor"),
    async (c: AppContext): Promise<Response> => {
      const workspace = c.get("workspace");
      const parsed = CREATE_THREAD_SCHEMA.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) {
        throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
          status: 400,
          hint: "Titles are at most 200 characters.",
          requestId: c.get("requestId"),
        });
      }
      const thread = await deps.repos.threads.create(workspace.id, {
        projectId: pathParam(c, "id"),
        createdBy: c.get("auth").user.id,
        title: parsed.data.title,
      });
      return ok(c, toThreadDto(thread), 201);
    },
  );

  app.get(
    "/v1/threads/:id/messages",
    requireWorkspace("viewer"),
    async (c: AppContext): Promise<Response> => {
      const query = PAGINATION_QUERY_SCHEMA.safeParse({
        cursor: c.req.query("cursor"),
        limit: c.req.query("limit"),
      });
      if (!query.success) {
        throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
          status: 400,
          hint: "Check the pagination parameters.",
          requestId: c.get("requestId"),
        });
      }
      const workspaceId = c.get("workspace").id;
      const result = await deps.repos.threads.listMessages(workspaceId, pathParam(c, "id"), {
        cursor: query.data.cursor ?? null,
        limit: query.data.limit,
      });
      return page(c, result.items.map(toMessageDto), result.nextCursor);
    },
  );

  return app;
}
