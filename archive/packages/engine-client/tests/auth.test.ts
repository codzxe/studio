// W2-B — engine auth: 256-bit tokens, token-file vs inline, redaction.
// Mirrors vendor crates/automation/src/security.rs and its test module.
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  AUTH_METHOD,
  CONTROL_TOKEN_BYTES,
  CONTROL_TOKEN_HEX_LENGTH,
  type EngineAuth,
  REDACTED_CONTROL_TOKEN,
  authRequestFrame,
  engineAuthFromEnv,
  generateControlToken,
  isControlToken,
  parseEngineAuth,
  redactEngineAuth,
  redactToken,
  resolveEngineToken,
  tokenMatches,
} from "../src/auth.js";

const HEX64 = /^[0-9a-f]{64}$/;

/** A valid 64-hex token whose text is distinctive enough to detect in leaks. */
const secretToken = `${"cafe".repeat(15)}babe`;

const scratchRoot = await mkdtemp(join(tmpdir(), "w2b-auth-"));
afterAll(async () => {
  await rm(scratchRoot, { recursive: true, force: true });
});

async function tokenFile(contents: string, mode: number): Promise<string> {
  const dir = await mkdtemp(join(scratchRoot, "case-"));
  const path = join(dir, "control.token");
  await writeFile(path, contents, { mode });
  await chmod(path, mode); // mkdtemp parents are 0700; force the intended file mode
  return path;
}

describe("auth: token generation (security.rs generate_token)", () => {
  it("emits exactly 64 lowercase hex characters (256-bit, 32 bytes)", () => {
    const token = generateControlToken();
    expect(token).toMatch(HEX64);
    expect(token).toHaveLength(CONTROL_TOKEN_HEX_LENGTH);
    expect(CONTROL_TOKEN_BYTES).toBe(32);
  });

  it("matches the construction security.rs uses (randomBytes(32).hex)", () => {
    expect(generateControlToken()).toHaveLength(randomBytes(32).toString("hex").length);
  });

  it("never repeats across a 64-token sample", () => {
    const tokens = new Set(Array.from({ length: 64 }, () => generateControlToken()));
    expect(tokens.size).toBe(64);
  });
});

describe("auth: token format (security.rs validate_token)", () => {
  it("accepts 64 lowercase hex characters", () => {
    expect(isControlToken("0123456789abcdef".repeat(4))).toBe(true);
  });

  it("accepts uppercase hex — #6425: a token authenticates in any letter case", () => {
    expect(isControlToken("0123456789ABCDEF".repeat(4))).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["63 chars", "0".repeat(63)],
    ["65 chars", "0".repeat(65)],
    ["non-hex byte", `0${"g".repeat(62)}0`],
    ["whitespace padded", ` ${"0".repeat(64)} `],
  ])("rejects %s", (_label, value) => {
    expect(isControlToken(value)).toBe(false);
  });
});

describe("auth: token comparison (security.rs token_matches)", () => {
  const lower = "0123456789abcdef".repeat(4);
  const upper = "0123456789ABCDEF".repeat(4);

  it("matches an identical token", () => {
    expect(tokenMatches(lower, lower)).toBe(true);
  });

  it("folds only A–Z, in both directions (#6425)", () => {
    expect(tokenMatches(upper, lower)).toBe(true);
    expect(tokenMatches(lower, upper)).toBe(true);
  });

  it("rejects a different token, wrong lengths, and non-hex bytes that would case-fold", () => {
    const other = "1123456789abcdef".repeat(4);
    const notHex = `0123456789ABCDEG${"0".repeat(47)}`;
    expect(tokenMatches(lower, other)).toBe(false);
    expect(tokenMatches(lower, "short")).toBe(false);
    expect(tokenMatches(lower, notHex)).toBe(false);
  });
});

describe("auth: EngineAuth config (token-file vs inline)", () => {
  it("parses an inline auth and a token-file auth", () => {
    expect(parseEngineAuth({ source: "inline", token: secretToken })).toEqual({
      ok: true,
      value: { source: "inline", token: secretToken },
    });
    expect(parseEngineAuth({ source: "file", tokenFile: "/private/control.token" })).toEqual({
      ok: true,
      value: { source: "file", tokenFile: "/private/control.token" },
    });
  });

  it("rejects malformed configs without ever echoing values", () => {
    const cases: unknown[] = [
      null,
      "inline",
      {},
      { source: "inline" },
      { source: "inline", token: "" },
      { source: "file" },
      { source: "carrier", token: secretToken },
      { source: "inline", token: secretToken, extra: 1 },
    ];
    for (const input of cases) {
      const result = parseEngineAuth(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("invalid_auth_config");
        expect(result.message).not.toContain(secretToken);
      }
    }
  });

  it("reports both-sources as auth_source_conflict, like security.rs client_token", () => {
    const result = parseEngineAuth({ token: secretToken, tokenFile: "/private/control.token" });
    expect(result).toMatchObject({ ok: false, code: "auth_source_conflict" });
  });
});

describe("auth: resolveEngineToken", () => {
  it("validates and lowercases an inline token", async () => {
    const resolved = await resolveEngineToken({
      source: "inline",
      token: secretToken.toUpperCase(),
    });
    expect(resolved).toEqual({ ok: true, value: secretToken });
  });

  it("refuses an invalid inline token without echoing it", async () => {
    const resolved = await resolveEngineToken({ source: "inline", token: "nope" });
    expect(resolved).toMatchObject({ ok: false, code: "invalid_token" });
    if (!resolved.ok) {
      expect(resolved.message).not.toContain("nope");
    }
  });

  it("reads an owner-only token file, trimming whitespace (#4966 checks)", async () => {
    const path = await tokenFile(`  ${secretToken.toUpperCase()}\n`, 0o600);
    const resolved = await resolveEngineToken({ source: "file", tokenFile: path });
    expect(resolved).toEqual({ ok: true, value: secretToken });
  });

  it("refuses a group/world-readable token file (#4966)", async () => {
    const path = await tokenFile(`${secretToken}\n`, 0o644);
    const resolved = await resolveEngineToken({ source: "file", tokenFile: path });
    expect(resolved).toMatchObject({ ok: false, code: "token_file_refused" });
  });

  it("refuses a missing file and a directory", async () => {
    const missing = await resolveEngineToken({
      source: "file",
      tokenFile: join(scratchRoot, "absent.token"),
    });
    expect(missing).toMatchObject({ ok: false, code: "token_file_refused" });

    const dir = await mkdtemp(join(scratchRoot, "not-a-file-"));
    const asDir = await resolveEngineToken({ source: "file", tokenFile: dir });
    expect(asDir).toMatchObject({ ok: false, code: "token_file_refused" });
  });

  it("refuses token-file contents that are not a valid token", async () => {
    const path = await tokenFile("clearly-not-a-token\n", 0o600);
    const resolved = await resolveEngineToken({ source: "file", tokenFile: path });
    expect(resolved).toMatchObject({ ok: false, code: "invalid_token" });
  });
});

describe("auth: engineAuthFromEnv (security.rs token_inputs)", () => {
  it("maps PHOTOCRAFT_CONTROL_TOKEN to an inline auth", () => {
    expect(engineAuthFromEnv({ PHOTOCRAFT_CONTROL_TOKEN: secretToken })).toEqual({
      ok: true,
      value: { source: "inline", token: secretToken },
    });
  });

  it("maps PHOTOCRAFT_CONTROL_TOKEN_FILE to a token-file auth", () => {
    expect(engineAuthFromEnv({ PHOTOCRAFT_CONTROL_TOKEN_FILE: "/private/control.token" })).toEqual({
      ok: true,
      value: { source: "file", tokenFile: "/private/control.token" },
    });
  });

  it("treats a present-but-empty value as present (std::env::var parity)", async () => {
    const auth = engineAuthFromEnv({ PHOTOCRAFT_CONTROL_TOKEN: "" });
    expect(auth).toEqual({ ok: true, value: { source: "inline", token: "" } });
    if (auth.ok) {
      const resolved = await resolveEngineToken(auth.value);
      expect(resolved).toMatchObject({ ok: false, code: "invalid_token" });
    }
  });

  it("rejects both set (conflict) and neither set (missing)", () => {
    expect(
      engineAuthFromEnv({ PHOTOCRAFT_CONTROL_TOKEN: "x", PHOTOCRAFT_CONTROL_TOKEN_FILE: "/p" }),
    ).toMatchObject({
      ok: false,
      code: "auth_source_conflict",
    });
    expect(engineAuthFromEnv({})).toMatchObject({ ok: false, code: "auth_missing" });
  });
});

describe("auth: first-frame auth request (control-protocol.md)", () => {
  it("builds the exact first-frame shape with a default id", () => {
    const frame = authRequestFrame(secretToken);
    expect(frame.ok).toBe(true);
    if (!frame.ok) return;
    expect(JSON.parse(frame.value)).toEqual({
      id: "auth",
      method: AUTH_METHOD,
      params: { token: secretToken },
    });
  });

  it("accepts a caller-supplied id and lowercases the token", () => {
    const frame = authRequestFrame(secretToken.toUpperCase(), 7);
    expect(frame.ok).toBe(true);
    if (!frame.ok) return;
    expect(JSON.parse(frame.value)).toEqual({
      id: 7,
      method: "auth",
      params: { token: secretToken },
    });
  });

  it("refuses to build a frame for an invalid token", () => {
    expect(authRequestFrame("short")).toMatchObject({ ok: false, code: "invalid_token" });
  });
});

describe("auth: redaction (control-protocol.md Security note: never log the token)", () => {
  const fileAuth: EngineAuth = { source: "file", tokenFile: "/private/control.token" };

  it("redactToken reveals nothing — constant output, no partial echo", () => {
    const redacted = redactToken(secretToken);
    expect(redacted).toBe(REDACTED_CONTROL_TOKEN);
    expect(redacted).not.toContain(secretToken);
    expect(redacted).not.toContain(secretToken.slice(0, 8));
    expect(redacted).not.toContain(secretToken.slice(-8));
  });

  it("redactEngineAuth names the source, never the secret or the path", () => {
    const inline = redactEngineAuth({ source: "inline", token: secretToken });
    expect(inline).not.toContain(secretToken);
    const file = redactEngineAuth(fileAuth);
    expect(file).not.toContain("/private/control.token");
  });
});
