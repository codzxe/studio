/**
 * Tiny internal health endpoint (plain node:http — the worker stays
 * dependency-light, §3.1). GET /health reports queue depths through the
 * injectable `QueueStatsSource` seam; src/index.ts adapts BullMQ queues to
 * it, so this module needs no broker and is trivially testable.
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "./logger.js";

export interface QueueDepth {
  readonly queue: string;
  readonly waiting: number;
  readonly active: number;
  readonly delayed: number;
  readonly completed: number;
  readonly failed: number;
}

/** Injectable stats source; tests and alternate deployments can fake it. */
export interface QueueStatsSource {
  getQueueDepths(): Promise<readonly QueueDepth[]>;
}

export interface HealthServerOptions {
  readonly port: number;
  /** Bind address; defaults to loopback (internal ops endpoint only). */
  readonly host?: string;
  readonly stats: QueueStatsSource;
  readonly logger?: Logger;
}

export interface HealthServer {
  readonly url: string;
  close(): Promise<void>;
}

export async function startHealthServer(options: HealthServerOptions): Promise<HealthServer> {
  const host = options.host ?? "127.0.0.1";
  const server = createServer((request, response) => {
    handleHealthRequest(request, response, options);
  });
  server.on("error", (error) => options.logger?.error("health server error", { err: error }));
  await new Promise<void>((resolve, reject) => {
    server.listen(options.port, host, () => {
      resolve();
    });
    server.once("error", reject);
  });
  const url = `http://${host}:${options.port}/health`;
  return {
    url,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => {
          resolve();
        });
      }),
  };
}

function handleHealthRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: HealthServerOptions,
): void {
  const url = new URL(request.url ?? "/", "http://worker.internal");
  if (request.method !== "GET" || (url.pathname !== "/health" && url.pathname !== "/healthz")) {
    sendJson(response, 404, {
      ok: false,
      code: "not_found",
      message: "unknown health route",
      hint: "GET /health",
    });
    return;
  }
  options.stats
    .getQueueDepths()
    .then((queues) => {
      sendJson(response, 200, {
        ok: true,
        service: "worker",
        uptimeSeconds: Math.floor(process.uptime()),
        queues,
      });
    })
    .catch((error: unknown) => {
      options.logger?.error("queue stats unavailable", { err: error });
      sendJson(response, 503, {
        ok: false,
        code: "queue_stats_unavailable",
        message: "queue statistics are currently unavailable",
        hint: "check the Valkey connection",
      });
    });
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
): void {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}
