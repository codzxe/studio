// @studio/engine-client — capability-scoped engine roots (W2-B).
//
// Mirrors vendor crates/automation/src/workspace.rs: automation filesystem access
// fails closed around launch-time read/write roots; request paths are untrusted
// forward-slash RELATIVE paths beneath the applicable root, and traversal,
// alternate separators, drive/device/stream prefixes, malformed components and
// absolute paths outside the root are rejected before any file effect.
//
// Studio tenancy model (§3.2, §15.1): one engine session per run, rooted at
// <baseDir>/organizations/<orgId>/sessions/<sessionId>/{assets,tmp,renders,save}.
// Read and write are INDEPENDENT capabilities resolved from the same per-tenant
// session directory — the engine receives --automation-read-root and
// --automation-write-root pointing at it, like the vendor's own example that
// grants one project directory for both. Studio policy is deliberately stricter
// than the engine: the engine accepts an absolute request path whose text lies
// beneath the root, but automation mode refuses ambient paths, so this client
// refuses EVERY absolute path and only ever emits root-relative request paths.
import { z } from "zod";

// ---------------------------------------------------------------------------
// Error surface — fleet envelope shape (docs/AGENTS.md). Self-contained on
// purpose: W2-B owns only src/{auth,capabilities,budgets}.ts, so each module
// keeps its own envelope (structurally compatible with @studio/config's Failure).
// ---------------------------------------------------------------------------

/** Capability-surface error codes (task W2-B: exactly these two). */
export const CAPABILITY_ERROR_CODES = [
  "path_outside_capability_root", // Malformed/unsafe path (traversal, separators, device names, empty components…).
  "ambient_path_refused", // Absolute / drive / UNC / home-relative path — refused in automation mode.
] as const satisfies readonly string[];

export type CapabilityErrorCode = (typeof CAPABILITY_ERROR_CODES)[number];

export interface CapabilityFailure {
  readonly ok: false;
  readonly code: CapabilityErrorCode;
  readonly message: string;
  readonly hint?: string;
  readonly retryable?: boolean;
}

export type CapabilityResult<T> = { readonly ok: true; readonly value: T } | CapabilityFailure;

interface FailOptions {
  readonly hint?: string;
  readonly retryable?: boolean;
}

function fail(code: CapabilityErrorCode, message: string, options: FailOptions = {}): CapabilityFailure {
  const failure: {
    ok: false;
    code: CapabilityErrorCode;
    message: string;
    hint?: string;
    retryable?: boolean;
  } = { ok: false, code, message };
  if (options.hint !== undefined) {
    failure.hint = options.hint;
  }
  if (options.retryable !== undefined) {
    failure.retryable = options.retryable;
  }
  return failure;
}

// ---------------------------------------------------------------------------
// Tenancy model
// ---------------------------------------------------------------------------

/** The two independent filesystem capabilities (workspace.rs AuthorizedWorkspace). */
export type CapabilityScope = "read" | "write";

/** Sanctioned per-session subdirectories (workspace model, W2-B task). */
export const SESSION_SUBDIRS = ["assets", "tmp", "renders", "save"] as const satisfies readonly string[];

export type SessionSubdir = (typeof SESSION_SUBDIRS)[number];

export interface EngineTenant {
  /** Trusted launch-time base (ENGINE_CAPABILITY_ROOT_BASE, §3.2) — never from a request. */
  readonly baseDir: string;
  /** Tenant directory component (db id, one path component). */
  readonly organizationId: string;
  /** Session directory component (db id, one path component). */
  readonly sessionId: string;
}

export const ENGINE_TENANT_SCHEMA = z.strictObject({
  baseDir: z.string().min(1),
  organizationId: z.string().min(1),
  sessionId: z.string().min(1),
});

/**
 * Boundary validation for untrusted tenant input (docs/AGENTS.md: Zod at every
 * boundary). Path-safety of the components is checked by resolveRoot, not here.
 */
export function parseEngineTenant(input: unknown): CapabilityResult<EngineTenant> {
  const parsed = ENGINE_TENANT_SCHEMA.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return fail("path_outside_capability_root", `engine tenant config failed schema validation: ${issues}`);
  }
  return { ok: true, value: parsed.data };
}

// ---------------------------------------------------------------------------
// Path-safety (mirrors workspace.rs relative_path + is_windows_device_name)
// ---------------------------------------------------------------------------

const WINDOWS_DEVICE_STEMS = new Set(["CON", "PRN", "AUX", "NUL", "CLOCK$", "CONIN$", "CONOUT$"]);

/** workspace.rs is_windows_device_name: stem (before '.') in {CON, PRN, …, COM1-9, LPT1-9}. */
export function isWindowsDeviceName(component: string): boolean {
  const stem = (component.split(".")[0] ?? component).toUpperCase();
  if (WINDOWS_DEVICE_STEMS.has(stem)) {
    return true;
  }
  return /^COM[1-9]$/.test(stem) || /^LPT[1-9]$/.test(stem);
}

/**
 * One safe forward-slash path component: non-empty, no `.`/`..`, no separators
 * or drive/device/stream prefixes, no trailing dot or space, no control
 * characters (client-side hardening beyond the vendor), no reserved Windows
 * device name.
 */
export function isSafePathComponent(component: string): boolean {
  if (component.length === 0) {
    return false;
  }
  if (component === "." || component === "..") {
    return false;
  }
  if (component.endsWith(".") || component.endsWith(" ")) {
    return false;
  }
  if (/[\u0000-\u001f\u007f]/.test(component)) {
    return false;
  }
  if (component.includes("/") || component.includes("\\") || component.includes(":")) {
    // Separators and drive/device/stream prefixes are rejected one level up in
    // validateRelativePath; the predicate stays self-consistent for standalone use
    // (tenant ids) where no raw-path check runs first.
    return false;
  }
  return !isWindowsDeviceName(component);
}

function reasonForComponent(component: string): string {
  if (component.length === 0) {
    return "empty path components are not allowed";
  }
  if (component === "..") {
    return "parent traversal is not allowed";
  }
  if (component === ".") {
    return "`.` path components are not allowed";
  }
  if (component.endsWith(".") || component.endsWith(" ")) {
    return "path components ending in a dot or space are not allowed";
  }
  if (/[\u0000-\u001f\u007f]/.test(component)) {
    return "control characters are not allowed";
  }
  if (component.includes("/") || component.includes("\\")) {
    return "path separators are not allowed";
  }
  if (component.includes(":")) {
    return "drive, device and stream prefixes are not allowed";
  }
  return "reserved device names are not allowed";
}

/**
 * Validate an engine request path. It must be a non-empty, forward-slash
 * relative path beneath the capability root, checked with the same rules as
 * workspace.rs relative_path: rejection, not normalization — nothing is ever
 * resolved or cleaned up on the caller's behalf.
 */
export function validateRelativePath(raw: string): CapabilityResult<string> {
  if (raw.length === 0) {
    return fail("path_outside_capability_root", "automation path rejected: path is empty");
  }
  if (raw.startsWith("/")) {
    return fail(
      "ambient_path_refused",
      "automation path rejected: absolute paths are not allowed; request paths must be relative to the capability root",
    );
  }
  if (raw.startsWith("\\\\")) {
    return fail("ambient_path_refused", "automation path rejected: UNC share paths are not allowed");
  }
  if (raw.startsWith("~")) {
    return fail("ambient_path_refused", "automation path rejected: home-relative paths are not allowed");
  }
  if (raw.includes(":")) {
    return fail("ambient_path_refused", "automation path rejected: drive, device and stream prefixes are not allowed");
  }
  if (raw.includes("\\")) {
    return fail("path_outside_capability_root", "automation path rejected: alternate separators are not allowed; use /");
  }
  for (const component of raw.split("/")) {
    if (!isSafePathComponent(component)) {
      return fail("path_outside_capability_root", `automation path rejected: ${reasonForComponent(component)}`);
    }
  }
  return { ok: true, value: raw };
}

// ---------------------------------------------------------------------------
// Root resolution
// ---------------------------------------------------------------------------

function stripTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === "/") {
    end -= 1;
  }
  return path.slice(0, end);
}

type TenantField = "organizationId" | "sessionId";

function checkTenantField(field: TenantField, value: string): CapabilityFailure | null {
  // Tenant ids are interpolated into the root, so they must be single safe
  // components; a hostile id is just traversal with extra steps. Messages name
  // the field, never the value (docs/AGENTS.md: never leak internal ids).
  if (value.startsWith("~") || !isSafePathComponent(value)) {
    return fail(
      "path_outside_capability_root",
      `engine tenant ${field} is not a safe path component; the resolved root would leave the capability base`,
      { hint: "tenant ids must be single forward-slash-free path components" },
    );
  }
  return null;
}

/**
 * The per-tenant session directory: <baseDir>/organizations/<orgId>/sessions/<sessionId>.
 * Both capability scopes are rooted here (see module comment).
 */
export function sessionDirectory(tenant: EngineTenant): CapabilityResult<string> {
  if (tenant.baseDir.trim().length === 0) {
    // workspace.rs open_root: an empty automation root is refused at launch.
    return fail("path_outside_capability_root", "engine capability baseDir is empty");
  }
  for (const field of ["organizationId", "sessionId"] as const satisfies readonly TenantField[]) {
    const bad = checkTenantField(field, tenant[field]);
    if (bad !== null) {
      return bad;
    }
  }
  const root = [
    stripTrailingSlashes(tenant.baseDir),
    "organizations",
    tenant.organizationId,
    "sessions",
    tenant.sessionId,
  ].join("/");
  return { ok: true, value: root };
}

/** One resolved capability root, ready to hand to the engine as a launch flag. */
export interface CapabilityRoot {
  /** Which authority this root grants (read and write are independent). */
  readonly scope: CapabilityScope;
  /** The per-tenant session directory the capability is rooted at. */
  readonly root: string;
  /** Root-relative request paths for the sanctioned session subdirectories. */
  readonly subdirs: Readonly<Record<SessionSubdir, string>>;
}

/**
 * Resolve the capability root for one scope and tenant. The same session
 * directory is returned for both scopes, but they remain SEPARATE capabilities:
 * the engine is launched with --automation-read-root <root> and
 * --automation-write-root <root> (workspace.rs AuthorizedWorkspace::new).
 */
export function resolveRoot(scope: CapabilityScope, tenant: EngineTenant): CapabilityResult<CapabilityRoot> {
  const dir = sessionDirectory(tenant);
  if (!dir.ok) {
    return dir;
  }
  return {
    ok: true,
    value: {
      scope,
      root: dir.value,
      subdirs: { assets: "assets", tmp: "tmp", renders: "renders", save: "save" },
    },
  };
}

/**
 * Absolute paths of the four session subdirectories, for the engine-pool to
 * create before a session starts (workspace.rs: the parent of a new output
 * file must already exist; nothing is auto-created by the engine).
 */
export function sessionLayout(tenant: EngineTenant): CapabilityResult<Readonly<Record<SessionSubdir, string>>> {
  const dir = sessionDirectory(tenant);
  if (!dir.ok) {
    return dir;
  }
  return {
    ok: true,
    value: {
      assets: `${dir.value}/assets`,
      tmp: `${dir.value}/tmp`,
      renders: `${dir.value}/renders`,
      save: `${dir.value}/save`,
    },
  };
}

/** A validated engine request path plus its joined filesystem form. */
export interface CapabilityPath {
  readonly scope: CapabilityScope;
  /** The capability root the path was resolved against. */
  readonly root: string;
  /** Validated root-relative request path — the ONLY form sent to the engine. */
  readonly relative: string;
  /** The same path joined under the root, for this service's own filesystem use. */
  readonly absolute: string;
}

/**
 * Resolve an engine request path beneath the capability root for one scope and
 * tenant. Rejections mirror workspace.rs exactly (traversal, alternate
 * separators, prefixes, device names, empty/malformed components) with the two
 * typed errors of this module; nothing is resolved on the filesystem here.
 */
export function capabilityPath(
  scope: CapabilityScope,
  tenant: EngineTenant,
  relative: string,
): CapabilityResult<CapabilityPath> {
  const validated = validateRelativePath(relative);
  if (!validated.ok) {
    return validated;
  }
  const root = sessionDirectory(tenant);
  if (!root.ok) {
    return root;
  }
  return {
    ok: true,
    value: { scope, root: root.value, relative: validated.value, absolute: `${root.value}/${validated.value}` },
  };
}
