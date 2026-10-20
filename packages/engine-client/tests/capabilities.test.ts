// W2-B — capability roots: per-tenant session dirs, traversal rejection,
// ambient path refusal. Mirrors vendor crates/automation/src/workspace.rs.
import { describe, expect, it } from "vitest";
import {
  type CapabilityScope,
  type EngineTenant,
  capabilityPath,
  isSafePathComponent,
  isWindowsDeviceName,
  parseEngineTenant,
  resolveRoot,
  sessionDirectory,
  sessionLayout,
  validateRelativePath,
} from "../src/capabilities.js";

const tenant: EngineTenant = {
  baseDir: "/srv/engine-roots",
  organizationId: "org_01HX",
  sessionId: "sess_01HY",
};

const sessionDir = "/srv/engine-roots/organizations/org_01HX/sessions/sess_01HY";
const scopes: CapabilityScope[] = ["read", "write"];

describe("capabilities: per-tenant session roots (§3.2 tenancy layout)", () => {
  it("roots both scopes at the same per-tenant session directory", () => {
    for (const scope of scopes) {
      const root = resolveRoot(scope, tenant);
      expect(root).toEqual({
        ok: true,
        value: {
          scope,
          root: sessionDir,
          subdirs: { assets: "assets", tmp: "tmp", renders: "renders", save: "save" },
        },
      });
    }
  });

  it("normalizes a trailing slash on the trusted baseDir", () => {
    const root = sessionDirectory({ ...tenant, baseDir: "/srv/engine-roots/" });
    expect(root).toEqual({ ok: true, value: sessionDir });
  });

  it("keeps a single slash for a root baseDir", () => {
    const root = sessionDirectory({ ...tenant, baseDir: "/" });
    expect(root).toEqual({
      ok: true,
      value: `/organizations/${tenant.organizationId}/sessions/${tenant.sessionId}`,
    });
  });

  it("lays out the four sanctioned subdirectories beneath the session dir", () => {
    const layout = sessionLayout(tenant);
    expect(layout).toEqual({
      ok: true,
      value: {
        assets: `${sessionDir}/assets`,
        tmp: `${sessionDir}/tmp`,
        renders: `${sessionDir}/renders`,
        save: `${sessionDir}/save`,
      },
    });
  });

  it("resolves a happy-path request path for every scope", () => {
    for (const scope of scopes) {
      const path = capabilityPath(scope, tenant, "assets/logo.png");
      expect(path).toEqual({
        ok: true,
        value: {
          scope,
          root: sessionDir,
          relative: "assets/logo.png",
          absolute: `${sessionDir}/assets/logo.png`,
        },
      });
    }
  });
});

describe("capabilities: tenant ids are single safe path components", () => {
  const attacks: Array<[keyof Pick<EngineTenant, "organizationId" | "sessionId">, string]> = [
    ["organizationId", "../evil"],
    ["organizationId", ".."],
    ["organizationId", "a/b"],
    ["organizationId", "a\\b"],
    ["organizationId", "C:x"],
    ["organizationId", "~root"],
    ["organizationId", "CON"],
    ["organizationId", "space "],
    ["organizationId", "dot."],
    ["organizationId", ""],
    ["sessionId", "sessions/../.."],
    ["sessionId", ""],
  ];

  it("refuses every traversal-shaped tenant id without echoing it", () => {
    for (const [field, value] of attacks) {
      const result = sessionDirectory({ ...tenant, [field]: value });
      expect(result.ok, `${field}=${JSON.stringify(value)}`).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("path_outside_capability_root");
        if (value.length > 0) {
          expect(result.message).not.toContain(value);
        }
        expect(result.message).toContain(field);
      }
    }
  });

  it("refuses an empty baseDir (workspace.rs open_root refuses empty roots)", () => {
    const result = sessionDirectory({ ...tenant, baseDir: "  " });
    expect(result).toMatchObject({ ok: false, code: "path_outside_capability_root" });
  });

  it("validates untrusted tenant input at the zod boundary", () => {
    expect(parseEngineTenant(tenant)).toEqual({ ok: true, value: tenant });
    const badInputs: unknown[] = [
      null,
      "x",
      [],
      { ...tenant, sessionId: "" },
      { ...tenant, extra: 1 },
    ];
    for (const bad of badInputs) {
      const result = parseEngineTenant(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("path_outside_capability_root");
      }
    }
  });
});

describe("capabilities: traversal and malformed paths are rejected (workspace.rs relative_path)", () => {
  const rejected: Array<[string, RegExp]> = [
    ["", /empty/],
    ["..", /traversal/],
    ["../escape.png", /traversal/],
    ["assets/../../x", /traversal/],
    [".", /`\.`/],
    ["./x", /`\.`/],
    ["a/./b", /`\.`/],
    ["a//b", /empty/],
    ["a/", /empty/],
    ["foo./bar", /dot or space/],
    ["foo /bar", /dot or space/],
    ["a\\b", /alternate separators/],
    ["\u0000.png", /control/],
    ["a\u007fb.png", /control/],
    ["CON", /device/],
    ["con.txt", /device/],
    ["com1", /device/],
    ["lpt9.png", /device/],
    ["clock$", /device/],
    ["nul", /device/],
  ];

  it("returns path_outside_capability_root for every malformed path", () => {
    for (const [raw, reason] of rejected) {
      const result = validateRelativePath(raw);
      expect(result.ok, JSON.stringify(raw)).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("path_outside_capability_root");
        expect(result.message).toMatch(reason);
        expect(result.message).not.toContain(sessionDir);
      }
    }
  });

  it("applies the same rejection through capabilityPath on both scopes", () => {
    for (const scope of scopes) {
      const result = capabilityPath(scope, tenant, "renders/../../escape.png");
      expect(result).toMatchObject({ ok: false, code: "path_outside_capability_root" });
    }
  });
});

describe("capabilities: ambient paths are refused (automation mode, control-protocol.md)", () => {
  const ambient: Array<[string, RegExp]> = [
    ["/etc/passwd", /absolute/],
    ["/srv/engine-roots/organizations/org_01HX/sessions/sess_01HY/assets/logo.png", /absolute/],
    ["~/secrets.png", /home-relative/],
    ["~user/x.png", /home-relative/],
    ["C:\\Users\\eve\\x.png", /drive, device and stream/],
    ["C:x.png", /drive, device and stream/],
    ["\\\\srv\\share\\x.png", /UNC/],
    ["file:name.png", /drive, device and stream/],
    ["assets/b:c.png", /drive, device and stream/],
  ];

  it("returns ambient_path_refused even when the absolute path is beneath the root", () => {
    for (const [raw, reason] of ambient) {
      const result = validateRelativePath(raw);
      expect(result.ok, JSON.stringify(raw)).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("ambient_path_refused");
        expect(result.message).toMatch(reason);
      }
    }
  });
});

describe("capabilities: component helpers", () => {
  it("isSafePathComponent accepts ordinary names and rejects unsafe ones", () => {
    for (const good of ["assets", "logo.png", "org_01HX", "sess-1", "v1.2"]) {
      expect(isSafePathComponent(good), good).toBe(true);
    }
    for (const bad of ["", ".", "..", "a\\b", "a/", "end.", "end ", "CON", "com9", "n\u0000l"]) {
      expect(isSafePathComponent(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("isWindowsDeviceName checks the stem before the first dot (workspace.rs)", () => {
    expect(isWindowsDeviceName("con.png")).toBe(true);
    expect(isWindowsDeviceName("aux")).toBe(true);
    expect(isWindowsDeviceName("COM1")).toBe(true);
    expect(isWindowsDeviceName("lpt9.tar.gz")).toBe(true);
    expect(isWindowsDeviceName("console.png")).toBe(false);
    expect(isWindowsDeviceName("com10")).toBe(false);
    expect(isWindowsDeviceName("conditions.x")).toBe(false);
  });
});
