// @studio/engine-client — engine control-token auth (W2-B).
//
// Mirrors vendor crates/automation/src/security.rs (256-bit tokens as 64 lowercase
// hex characters, case-folding constant-time-style comparison, owner-only token
// files) and the "Security note" in vendor/photocraft/docs/control-protocol.md:
// the TCP control protocol is a bearer token on loopback, unencrypted, so the
// token must never be logged, committed, or passed on a visible command line.
//
// Roles (security.rs): the engine-pool SUPERVISOR generates a token to CONFIGURE a
// spawned engine (the `server_token` role — `--control-token-file` gets mode 0600);
// every client connection then authenticates with it (the `client_token` role).
// Clients never silently generate credentials: `resolveEngineToken` fails closed.
import { randomBytes } from "node:crypto";
import { readFile, stat, type Stats } from "node:fs/promises";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Error surface — fleet envelope shape (docs/AGENTS.md: { ok:false, code,
// message, hint?, retryable? }). Self-contained on purpose: W2-B owns only
// src/{auth,capabilities,budgets}.ts, so each module keeps its own envelope
// (structurally compatible with @studio/config's Failure).
// ---------------------------------------------------------------------------

/** Auth-surface error codes. Add-only, stable strings (§13.3 discipline). */
export const AUTH_ERROR_CODES = [
  "invalid_token", // Not exactly 64 hexadecimal characters (inline token or token-file contents).
  "token_file_refused", // Missing, not a regular file, unreadable, or readable by group/others.
  "auth_source_conflict", // Both an inline token and a token file were supplied.
  "auth_missing", // Neither an inline token nor a token file was supplied.
  "invalid_auth_config", // EngineAuth shape failed schema validation at a boundary.
] as const satisfies readonly string[];

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

export interface AuthFailure {
  readonly ok: false;
  readonly code: AuthErrorCode;
  readonly message: string;
  readonly hint?: string;
  readonly retryable?: boolean;
}

export type AuthResult<T> = { readonly ok: true; readonly value: T } | AuthFailure;

interface FailOptions {
  readonly hint?: string;
  readonly retryable?: boolean;
}

function fail(code: AuthErrorCode, message: string, options: FailOptions = {}): AuthFailure {
  const failure: { ok: false; code: AuthErrorCode; message: string; hint?: string; retryable?: boolean } = {
    ok: false,
    code,
    message,
  };
  if (options.hint !== undefined) {
    failure.hint = options.hint;
  }
  if (options.retryable !== undefined) {
    failure.retryable = options.retryable;
  }
  return failure;
}

// ---------------------------------------------------------------------------
// Token format (security.rs TOKEN_BYTES = 32, TOKEN_HEX_LEN = 64)
// ---------------------------------------------------------------------------

/** Token entropy in bytes: 256-bit (security.rs TOKEN_BYTES). */
export const CONTROL_TOKEN_BYTES = 32;

/** Token text length: 64 hexadecimal characters (security.rs TOKEN_HEX_LEN). */
export const CONTROL_TOKEN_HEX_LENGTH = 64;

/** Fixed-width hex format accepted by security.rs validate_token (either letter case). */
const HEX_TOKEN = /^[0-9a-fA-F]{64}$/;

/**
 * Generate a fresh 256-bit control token with the OS CSPRNG — the exact
 * construction of security.rs generate_token (32 random bytes, lowercase hex).
 * The engine-pool supervisor uses this to configure spawned engines; clients
 * never silently generate credentials (security.rs client_token).
 */
export function generateControlToken(): string {
  return randomBytes(CONTROL_TOKEN_BYTES).toString("hex");
}

/** Accept only the fixed-width hexadecimal representation emitted by generateControlToken. */
export function isControlToken(value: string): boolean {
  return HEX_TOKEN.test(value);
}

/** Validate and normalize (lowercase) a token, exactly like security.rs server/client_token. */
function validateToken(token: string): AuthResult<string> {
  if (!isControlToken(token)) {
    return fail(
      "invalid_token",
      "control token must contain exactly 64 hexadecimal characters",
      { hint: "generate one with generateControlToken or read the engine's token file" },
    );
  }
  return { ok: true, value: token.toLowerCase() };
}

/**
 * Compare fixed-width tokens without an early exit on a mismatching byte,
 * mirroring security.rs token_matches: only `A`–`Z` fold to lowercase, so a
 * non-hex byte never matches a hex digit (#6425: a token authenticates in any
 * letter case; the server keeps the token lowercased).
 */
export function tokenMatches(expected: string, supplied: string): boolean {
  if (expected.length !== CONTROL_TOKEN_HEX_LENGTH || supplied.length !== CONTROL_TOKEN_HEX_LENGTH) {
    return false;
  }
  let different = 0;
  for (let i = 0; i < CONTROL_TOKEN_HEX_LENGTH; i += 1) {
    different |= foldAscii(expected.charCodeAt(i)) ^ foldAscii(supplied.charCodeAt(i));
  }
  return different === 0;
}

/** ASCII lowercase fold for `A`–`Z` only; every other byte folds to itself. */
function foldAscii(code: number): number {
  return code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
}

// ---------------------------------------------------------------------------
// Redaction — the token must never reach a log (control-protocol.md, Security note)
// ---------------------------------------------------------------------------

/** Constant replacement for a secret in logs; reveals nothing, not even length. */
export const REDACTED_CONTROL_TOKEN = "[redacted engine control token]";

/** Replace a control token with a constant — use at every log call site. */
export function redactToken(_token: string): string {
  return REDACTED_CONTROL_TOKEN;
}

/** Loggable description of an EngineAuth: names the source, never the secret or path. */
export function redactEngineAuth(auth: EngineAuth): string {
  return auth.source === "inline"
    ? "engine auth: inline control token (redacted)"
    : "engine auth: control token file (path redacted)";
}

// ---------------------------------------------------------------------------
// EngineAuth — how a client passes the credential (token file vs inline token)
// ---------------------------------------------------------------------------

/**
 * Typed auth config. The discriminated union makes "both a token and a token
 * file" (security.rs: "use either … not both") and "neither" structurally
 * unrepresentable; `engineAuthFromEnv` still reports both cases with typed
 * errors when they arrive from an untyped environment.
 */
export const ENGINE_AUTH_SCHEMA = z.discriminatedUnion("source", [
  z.strictObject({ source: z.literal("inline"), token: z.string().min(1) }),
  z.strictObject({ source: z.literal("file"), tokenFile: z.string().min(1) }),
]);

export type EngineAuth = z.infer<typeof ENGINE_AUTH_SCHEMA>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Boundary validation (docs/AGENTS.md: Zod at every boundary). Never echoes
 * values: only zod issue paths and messages are surfaced.
 */
export function parseEngineAuth(input: unknown): AuthResult<EngineAuth> {
  if (isRecord(input) && "token" in input && "tokenFile" in input) {
    // Faithful to security.rs client_token/server_token: supplying both sources is
    // its own error, not a generic schema failure.
    return fail("auth_source_conflict", "use either a control token or a control token file, not both");
  }
  const parsed = ENGINE_AUTH_SCHEMA.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return fail("invalid_auth_config", `engine auth config failed schema validation: ${issues}`);
  }
  return { ok: true, value: parsed.data };
}

/**
 * Resolve the token a client authenticates with (security.rs client_token).
 * An inline token must be valid 64-hex already; a token file is read with the
 * same trust checks the engine applies (#4966): regular file, no group/other
 * read bit (POSIX), contents trimmed and validated. The returned token is
 * lowercased exactly like security.rs. Messages deliberately omit the file
 * path (docs/AGENTS.md: never leak absolute paths).
 */
export async function resolveEngineToken(auth: EngineAuth): Promise<AuthResult<string>> {
  if (auth.source === "inline") {
    return validateToken(auth.token);
  }
  return readTokenFile(auth.tokenFile);
}

async function readTokenFile(path: string): Promise<AuthResult<string>> {
  let info: Stats;
  try {
    info = await stat(path);
  } catch {
    return fail("token_file_refused", "control token file cannot be opened", {
      hint: "check that the token file exists and is readable by this process only",
      retryable: false,
    });
  }
  if (!info.isFile()) {
    return fail("token_file_refused", "control token file is not a regular file");
  }
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    // #4966: a group- or world-readable token file is refused, not trusted.
    return fail("token_file_refused", "control token file is readable by group or others; restrict it to its owner (e.g. chmod 600)");
  }
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch {
    return fail("token_file_refused", "control token file cannot be read", { retryable: false });
  }
  return validateToken(contents.trim());
}

// ---------------------------------------------------------------------------
// Environment equivalents (control-protocol.md: PHOTOCRAFT_CONTROL_TOKEN /
// PHOTOCRAFT_CONTROL_TOKEN_FILE). These configure the VENDOR engine process,
// so they keep the engine's names; studio-side env parsing stays in
// @studio/config. Pure: the caller injects the record.
// ---------------------------------------------------------------------------

export interface EngineAuthEnv {
  readonly PHOTOCRAFT_CONTROL_TOKEN?: string | undefined;
  readonly PHOTOCRAFT_CONTROL_TOKEN_FILE?: string | undefined;
}

/**
 * Build an EngineAuth from the engine's token environment variables
 * (security.rs token_inputs). A key that is present but empty is still
 * "present" — mirroring std::env::var — so an empty token later fails
 * validation with `invalid_token` instead of being silently ignored.
 */
export function engineAuthFromEnv(env: EngineAuthEnv): AuthResult<EngineAuth> {
  const { PHOTOCRAFT_CONTROL_TOKEN: token, PHOTOCRAFT_CONTROL_TOKEN_FILE: tokenFile } = env;
  if (token !== undefined && tokenFile !== undefined) {
    return fail("auth_source_conflict", "use either a control token or a control token file, not both");
  }
  if (token !== undefined) {
    return { ok: true, value: { source: "inline", token } };
  }
  if (tokenFile !== undefined) {
    return { ok: true, value: { source: "file", tokenFile } };
  }
  return fail("auth_missing", "engine auth needs a control token or a control token file", {
    hint: "set PHOTOCRAFT_CONTROL_TOKEN or PHOTOCRAFT_CONTROL_TOKEN_FILE",
  });
}

// ---------------------------------------------------------------------------
// First-frame authentication (control-protocol.md)
// ---------------------------------------------------------------------------

/** The first request on every TCP connection must use this method (security.rs AUTH_METHOD). */
export const AUTH_METHOD = "auth";

/**
 * Build the first-frame auth request every TCP connection must send before any
 * other method is dispatched. The token is validated first so a malformed
 * credential never touches the socket. Returns the JSON line WITHOUT its
 * trailing newline; the transport appends it.
 */
export function authRequestFrame(token: string, id: string | number = AUTH_METHOD): AuthResult<string> {
  const checked = validateToken(token);
  if (!checked.ok) {
    return checked;
  }
  return {
    ok: true,
    value: JSON.stringify({ id, method: AUTH_METHOD, params: { token: checked.value } }),
  };
}
