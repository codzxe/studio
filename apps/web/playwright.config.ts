/**
 * Playwright config — the CI-owned E2E for the M4 chat loop
 * (apps/web/e2e/chat.spec.ts; BUILD_PLAN §M4 task 7).
 *
 * NOT TYPECHECKED ON THE BUILD-FLEET BOX: `@playwright/test` is not a
 * devDependency there (no browsers, no dev servers — docs/AGENTS.md), so
 * apps/web/tsconfig.json excludes this file and `e2e/` from typecheck. CI
 * adds the devDep (lockfile sync is CI-owned) — see e2e/README.md for the
 * full recipe this config assumes:
 *
 *   DATABASE_URL + seeded demo project + staged .ecproj fixture (README §3),
 *   MOCK_MODEL=true gateway on :8787, `next dev` on :3000, and the edge below.
 *
 * Why an edge at all: the browser talks same-origin `/v1/*` (the production
 * shape is Caddy fronting gateway+web — infra/caddy/Caddyfile). The webServer
 * command therefore boots THREE things behind ONE port:
 *
 *   1. a ~15-line node:http reverse proxy (the "edge", default :3100) —
 *      `/v1/*` → gateway (SSE is piped through unbuffered, so message deltas
 *      stream), everything else → `next dev`;
 *   2. the gateway (`pnpm --filter @studio/gateway dev`, MOCK_MODEL=true);
 *   3. the web app (`pnpm --filter @studio/web dev`, port 3000).
 *
 * The shell payload runs everything in one process group and `kill 0`s the
 * whole group when Playwright stops (the `trap`), so no orphans survive a
 * cancelled run. Set APP_URL/NEXT_PUBLIC_APP_URL to the EDGE origin
 * (http://127.0.0.1:3100) — better-auth signs URLs and checks origins against
 * APP_URL, and the local storage driver builds download URLs from it.
 *
 * Alternatives (README §Edge): a real Caddy with a 15-line Caddyfile for the
 * production-shaped edge, or hand-booting the three processes yourself.
 */

import { defineConfig, devices } from "@playwright/test";

/** Edge port — the ORIGIN the browser (baseURL) and APP_URL both use. */
const EDGE_PORT = Number.parseInt(process.env.E2E_EDGE_PORT ?? "3100", 10);
/** `next dev` port (the web app must be on this port for the edge to find it). */
const WEB_PORT = Number.parseInt(process.env.E2E_WEB_PORT ?? "3000", 10);
/** Gateway port (services/gateway defaults to 8787 via `parsePort(process.env.PORT)`). */
const GATEWAY_PORT = Number.parseInt(process.env.E2E_GATEWAY_PORT ?? "8787", 10);

/**
 * The dev edge: same-origin `/v1` → gateway, everything else → Next. Written
 * as an inline `node -e` payload so the whole boot recipe stays ONE command
 * with zero extra files/dependencies. Requirements it satisfies:
 * - SSE: upstream chunks are piped the moment they arrive (no buffering);
 * - hop-by-hop: the upstream Host is rewritten, status+headers pass through;
 * - readiness: until an upstream is listening the edge answers 502, which
 *   keeps Playwright's webServer poll waiting (it wants 2xx from `url`).
 *
 * No single quotes inside — the payload is single-quoted in the command.
 */
const EDGE_PROXY_JS = [
  'const http = require("http");',
  `const targets = { api: ${GATEWAY_PORT}, web: ${WEB_PORT} };`,
  "http.createServer((req, res) => {",
  '  const port = req.url.startsWith("/v1") ? targets.api : targets.web;',
  '  const upstream = http.request({ host: "127.0.0.1", port, method: req.method, path: req.url,',
  '    headers: { ...req.headers, host: "127.0.0.1:" + port } }, (up) => {',
  "    res.writeHead(up.statusCode || 502, up.headers);",
  "    up.pipe(res);",
  "  });",
  '  upstream.on("error", () => {',
  '    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });',
  '    res.end("e2e edge: upstream not reachable yet");',
  "  });",
  "  req.pipe(upstream);",
  `}).listen(${EDGE_PORT}, "127.0.0.1", () => console.log("e2e edge on ${EDGE_PORT}"));`,
].join("\n");

/** One webServer, three supervised processes (see the module header). */
const BOOT_COMMAND = [
  "trap 'kill 0' EXIT TERM INT;",
  `node -e '${EDGE_PROXY_JS}' &`,
  "pnpm --filter @studio/gateway dev &",
  "pnpm --filter @studio/web dev &",
  "wait",
].join(" ");

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e/.results",
  // One browser at a time: a single seeded project + deterministic chat runs
  // (the mock streams finish in milliseconds, but the editor boot is heavy).
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${EDGE_PORT}`,
    // First-hit dev compiles of the editor route can be slow on cold CI.
    navigationTimeout: 60_000,
    actionTimeout: 10_000,
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  expect: {
    // Attribute/text waits that need longer pass their own explicit timeout.
    timeout: 10_000,
  },
  // Chromium only (BUILD_PLAN §M4): one deterministic engine for the wasm
  // editor + visual baselines. Desktop Chrome = 1280×720, deviceScaleFactor 1.
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: BOOT_COMMAND,
    url: `http://127.0.0.1:${EDGE_PORT}/`,
    timeout: 240_000,
    // CI always boots its own stack; a local run may reuse a live one.
    reuseExistingServer: !process.env.CI,
  },
});
