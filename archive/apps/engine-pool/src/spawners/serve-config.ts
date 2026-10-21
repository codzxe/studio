// @studio/engine-pool — pure spawn-plan builder for `photocraft-cli serve` (§2.2, §3.2).
//
// Everything in this file is a pure function of its inputs: no `process.env` reads,
// no fs, no spawning, no clocks. `./photocraft-serve.ts` turns the produced plan into
// a real child process; `tests/serve-config.test.ts` covers the contract without a
// binary. Vendor truth (verify, never invent — docs/AGENTS.md):
//
// - `serve` accepts ONLY these value flags and NO bare flags
//   (vendor apps/photocraft-cli/src/lib.rs:101-106):
//     --port, --control-token, --control-token-file,
//     --automation-read-root, --automation-write-root
// - Flags are `--flag value` or `--flag=value` (lib.rs:110-140); an unknown flag is a
//   usage error → exit code 2 (lib.rs:203-209: 0 ok, 1 failure, 2 usage).
// - With `--port` (u16; 0 = kernel-assigned ephemeral) serve binds `127.0.0.1:<port>`
//   and refuses non-loopback addresses (lib.rs:571-574; rpc.rs:311-316). On STDERR it
//   prints, in order (lib.rs:568-592):
//     1. `photocraft-cli control token file: <path>`    (token resolved from a file)
//     2. `photocraft-cli serving on 127.0.0.1:<port>`   (readiness: AFTER the bind
//        succeeds, BEFORE the accept loop — rpc.rs:317; with `--port 0` this line
//        reports the kernel-assigned ephemeral port)
// - Without `--port`, serve speaks JSON lines on stdio with NO token and NO startup
//   banner (lib.rs:587-590) and exits 0 on stdin EOF (rpc.rs:247-264).
// - Token resolution (crates/automation/src/security.rs): flags first, env
//   PHOTOCRAFT_CONTROL_TOKEN / PHOTOCRAFT_CONTROL_TOKEN_FILE as fallback
//   (security.rs:312-316). An existing token file is read and validated (regular
//   file, mode 0600, exactly 64 hex chars — security.rs:92-97, 141-166); a missing
//   file is CREATED 0600 with a freshly GENERATED token (security.rs:168-181,
//   185-211) which would NOT match the pool's token — so the spawner writes the file
//   itself before spawning, and serve authenticates with the pool's token.
// - The capability roots must exist at spawn time (workspace.rs `open_root`:155-165
//   opens them; failure exits 1) and are read from flags only — the env equivalents
//   are NOT supported by `serve` (docs/control-protocol.md:344-348).
// - Session-dir layout mirrors the CANONICAL resolver in
//   `packages/engine-client/src/capabilities.ts` (W2-B): `sessionDirectory()` /
//   `resolveRoot()` build `<base>/organizations/<orgId>/sessions/<sessionId>` whose
//   sanctioned subdirs are `assets`/`tmp`/`renders`/`save`, and BOTH capability
//   scopes (read and write) are granted that same session directory. The token file
//   lives in the session's `tmp` subdir. NOTE(W2-G): `resolveRoot` exists under
//   exactly that name, but `@studio/engine-client` is NOT a dependency of this
//   package (apps/engine-pool/package.json — not W2-G's file), so this module keeps
//   a faithful local mirror; switch the import on once that dependency is added.

import { spawnFailed } from "../errors.js";
import type { SpawnRequest } from "../types.js";

/** Value flags the `serve` subcommand accepts (lib.rs:103). It has no bare flags. */
export const SERVE_VALUE_FLAGS: readonly string[] = [
  "--port",
  "--control-token",
  "--control-token-file",
  "--automation-read-root",
  "--automation-write-root",
];

/**
 * Env the child must never inherit: token/roots could override the explicit flags via
 * the `token_inputs` env fallback (security.rs:312-316) and silently change the
 * credential or capability scope. Scrubbed from the parent env AND pool extras.
 */
export const SCRUBBED_ENV_KEYS: readonly string[] = [
  "PHOTOCRAFT_CONTROL_TOKEN",
  "PHOTOCRAFT_CONTROL_TOKEN_FILE",
  "PHOTOCRAFT_AUTOMATION_READ_ROOT",
  "PHOTOCRAFT_AUTOMATION_WRITE_ROOT",
];

/** Fixed dir names inside the capability-root base — mirror W2-B capabilities.ts. */
export const ORGANIZATIONS_DIR_NAME = "organizations";
export const SESSIONS_DIR_NAME = "sessions";
/** Sanctioned session subdir holding the token file (W2-B `SESSION_SUBDIRS`). */
export const TMP_DIR_NAME = "tmp";
/** Vendor terminology: the "control token file" — 0600, one 64-hex token. */
export const TOKEN_FILE_NAME = "control-token";

/** lib.rs:582-584 — the readiness line prefix (printed after the loopback bind). */
export const SERVING_LINE_PREFIX = "photocraft-cli serving on ";
/** lib.rs:577-578 — informational prefix when the token is resolved from a file. */
export const TOKEN_FILE_LINE_PREFIX = "photocraft-cli control token file: ";

/** Transport selection mirrors lib.rs `serve`: `--port` → TCP, absent → stdio lines. */
export type ServeTransport = "tcp" | "stdio";

/** Per-session directory layout beneath the capability-root base (§3.2). */
export interface SessionDirs {
  /** `<base>/organizations/<org>/sessions/<session>` — one session, one tenant (§25 rule 4). */
  readonly sessionDir: string;
  /** Sanctioned `tmp` subdir of the session (W2-B SESSION_SUBDIRS). */
  readonly tmpDir: string;
  /** Where the control token lives: `<tmpDir>/control-token`, 0600 (§3.2, §15.1). */
  readonly tokenFilePath: string;
}

/** Deployment inputs that come from env parsing, never defaulted here (§4 fail-fast). */
export interface ServeConfig {
  /** Absolute path to the `photocraft-cli` binary — env `ENGINE_BINARY_PATH`. */
  readonly binaryPath: string;
  /** Base dir for per-session capability roots — env `ENGINE_CAPABILITY_ROOT_BASE`. */
  readonly capabilityRootBase: string;
  /** Parent env for the child; sanitized by `buildChildEnv`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Everything `photocraft-serve.ts` needs to launch one engine process. */
export interface ServeSpawnPlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly dirs: SessionDirs;
  readonly transport: ServeTransport;
  /** Requested port (0 = ephemeral; reported back via the serving line). Undefined = stdio. */
  readonly port: number | undefined;
}

/**
 * A directory segment the pool may interpolate into a path — the same rule as
 * `checkTenantField`/`isSafePathComponent` in the canonical capabilities.ts: a
 * hostile id is just traversal with extra steps, so this fails closed (§15.1).
 */
const WINDOWS_DEVICE_STEMS = new Set(["CON", "PRN", "AUX", "NUL", "CLOCK$", "CONIN$", "CONOUT$"]);

/** Any C0 control char or DEL — same rule as canonical `isSafePathComponent`. */
function hasControlChar(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function isSafeDirSegment(segment: string): boolean {
  if (segment.length === 0) return false;
  if (segment === "." || segment === "..") return false;
  if (
    segment.includes("/") ||
    segment.includes("\\") ||
    segment.includes(":") ||
    segment.startsWith("~")
  ) {
    return false;
  }
  if (segment.endsWith(".") || segment.endsWith(" ")) return false;
  if (hasControlChar(segment)) return false;
  const stem = (segment.split(".")[0] ?? segment).toUpperCase();
  return !WINDOWS_DEVICE_STEMS.has(stem) && !/^COM[1-9]$/.test(stem) && !/^LPT[1-9]$/.test(stem);
}

/** Control tokens are exactly 64 hexadecimal characters (security.rs:92-97). */
export function isControlToken(value: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(value);
}

/** Loopback TCP ports: 0 = ephemeral (kernel-assigned, reported on the serving line). */
export function isLoopbackPort(port: number): boolean {
  return Number.isInteger(port) && port >= 0 && port <= 65535;
}

/**
 * Capability-root layout for one session, mirroring the canonical `sessionDirectory()`
 * in `packages/engine-client/src/capabilities.ts` (W2-B):
 * `<base>/organizations/<orgId>/sessions/<sessionId>` with a `tmp` subdir holding the
 * control-token file (§3.2: roots scoped to that workspace's directory).
 *
 * The canonical exports are `resolveRoot`/`sessionLayout` — the name `resolveRoot`
 * matched the W2-G brief, but this package cannot import `@studio/engine-client`
 * (not a dependency in apps/engine-pool/package.json, which W2-G does not own), so
 * the layout is mirrored here. `buildServeSpawnPlan` forwards
 * `SpawnRequest.readRoot/writeRoot` verbatim, so callers can use either resolver.
 */
export function resolveSessionDirs(options: {
  readonly baseDir: string;
  readonly organizationId: string;
  readonly sessionId: string;
}): SessionDirs {
  const { baseDir, organizationId, sessionId } = options;
  if (
    baseDir.trim().length === 0 ||
    !isSafeDirSegment(organizationId) ||
    !isSafeDirSegment(sessionId)
  ) {
    // Fail closed: an id that could escape the session dir must never reach argv/fs.
    throw spawnFailed(new Error("invalid capability-root dir segment"));
  }
  // Mirrors capabilities.ts: trailing slashes are stripped, segments joined with "/".
  let stripped = baseDir;
  while (stripped.length > 1 && stripped.endsWith("/")) {
    stripped = stripped.slice(0, -1);
  }
  const sessionDir = [
    stripped,
    ORGANIZATIONS_DIR_NAME,
    organizationId,
    SESSIONS_DIR_NAME,
    sessionId,
  ].join("/");
  const tmpDir = `${sessionDir}/${TMP_DIR_NAME}`;
  return {
    sessionDir,
    tmpDir,
    tokenFilePath: `${tmpDir}/${TOKEN_FILE_NAME}`,
  };
}

/**
 * Child env: sanitized parent, then the pool's per-request extras — nothing ambient.
 * Token/root vars are scrubbed from BOTH layers so the explicit flags (and our token
 * file) are the only sources the engine can see. The result is the COMPLETE env.
 */
export function buildChildEnv(
  parent?: Readonly<Record<string, string | undefined>>,
  extra?: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  const write = (key: string, value: string | undefined): void => {
    if (value === undefined || SCRUBBED_ENV_KEYS.includes(key)) return;
    env[key] = value;
  };
  for (const [key, value] of Object.entries(parent ?? {})) write(key, value);
  for (const [key, value] of Object.entries(extra ?? {})) write(key, value);
  return env;
}

/**
 * The readiness line serve prints on stderr once the listener is bound:
 * `photocraft-cli serving on 127.0.0.1:<port>` (lib.rs:582-584; the callback runs
 * before the accept loop, rpc.rs:311-317). Returns the bound port — with `--port 0`
 * this is the kernel-assigned ephemeral port — or undefined for any other line
 * (e.g. the token-file line, or a non-loopback address rpc would have refused).
 */
export function parseServingPort(line: string): number | undefined {
  const match = /^photocraft-cli serving on 127\.0\.0\.1:(\d{1,5})$/.exec(line.trim());
  const digits = match?.[1];
  if (digits === undefined) return undefined;
  const port = Number.parseInt(digits, 10);
  return isLoopbackPort(port) ? port : undefined;
}

/** Replace every occurrence of each secret with `[redacted]` before buffering output. */
export function redactSecrets(line: string, secrets: readonly string[]): string {
  let redacted = line;
  for (const secret of secrets) {
    if (secret.length > 0) redacted = redacted.replaceAll(secret, "[redacted]");
  }
  return redacted;
}

/**
 * Build the exact spawn plan for one `photocraft-cli serve` process:
 * - TCP (`port !== undefined`): loopback bind (0 = ephemeral), token via the
 *   per-session 0600 token FILE (never argv — `ps` must not see it,
 *   control-protocol.md:340-342), roots from the request.
 * - stdio (`port === undefined`): JSON lines on stdio, NO token (lib.rs:587-590 —
 *   access is inherited from the pipe).
 * Throws a typed `spawn_failed` error on invalid input, so the pool's spawn boundary
 * fails fast instead of the engine exiting 1/2 later.
 */
export function buildServeSpawnPlan(request: SpawnRequest, config: ServeConfig): ServeSpawnPlan {
  if (config.binaryPath.length === 0) {
    throw spawnFailed(new Error("binaryPath must not be empty (ENGINE_BINARY_PATH)"));
  }
  if (!isControlToken(request.token)) {
    // serve validates this too (security.rs:92-97) and would exit 1 after reading the
    // file; failing here keeps the error at the pool boundary.
    throw spawnFailed(new Error("control token must be 64 hex characters (§3.2)"));
  }
  if (request.readRoot.length === 0 || request.writeRoot.length === 0) {
    // workspace.rs:157-158: an empty root is refused by serve (exit 1).
    throw spawnFailed(new Error("capability roots must not be empty"));
  }

  const dirs = resolveSessionDirs({
    baseDir: config.capabilityRootBase,
    organizationId: request.organizationId,
    sessionId: request.sessionId,
  });
  const env = buildChildEnv(config.env, request.env);
  const transport: ServeTransport = request.port === undefined ? "stdio" : "tcp";

  // lib.rs:250-252: roots are read from flags only — forwarded verbatim from the pool.
  const rootArgs = [
    "--automation-read-root",
    request.readRoot,
    "--automation-write-root",
    request.writeRoot,
  ] as const;

  if (transport === "stdio") {
    return {
      command: config.binaryPath,
      args: ["serve", ...rootArgs],
      env,
      dirs,
      transport,
      port: undefined,
    };
  }

  const port = request.port;
  if (port === undefined || !isLoopbackPort(port)) {
    throw spawnFailed(new Error(`invalid loopback port: ${String(request.port)}`));
  }
  return {
    command: config.binaryPath,
    args: [
      "serve",
      // lib.rs:571-574: parsed as u16; 0 asks the kernel for an ephemeral loopback port.
      "--port",
      String(port),
      // The token lives in a 0600 file, never on the command line (`ps` must not see
      // it — control-protocol.md:340-342). The spawner writes this file pre-spawn.
      "--control-token-file",
      dirs.tokenFilePath,
      ...rootArgs,
    ],
    env: {
      ...env,
      // security.rs:312-316: env fallback — the SAME file as the flag, belt-and-braces
      // so the child resolves the credential even if argv handling ever changes.
      PHOTOCRAFT_CONTROL_TOKEN_FILE: dirs.tokenFilePath,
    },
    dirs,
    transport,
    port,
  };
}
