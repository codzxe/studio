import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STATUS_BADGE_VARIANT, statusBadgeVariant } from "../src/components/badge.js";

const tokensCss = readFileSync(
  fileURLToPath(new URL("../src/tokens.css", import.meta.url)),
  "utf8",
);

describe("tokens.css", () => {
  it("parses: braces are balanced and declarations are well-formed", () => {
    const open = (tokensCss.match(/\{/g) ?? []).length;
    const close = (tokensCss.match(/\}/g) ?? []).length;
    expect(open).toBeGreaterThan(0);
    expect(open).toBe(close);
    // no stray doubled semicolons (unterminated declarations)
    expect(tokensCss).not.toMatch(/;\s*;/);
  });

  it("defines the core semantic token set on :root", () => {
    for (const token of [
      "--background",
      "--foreground",
      "--card",
      "--popover",
      "--primary",
      "--secondary",
      "--muted",
      "--accent", // one accent placeholder — overridden by workspace brand tokens (§7.5)
      "--border",
      "--input",
      "--ring",
      "--destructive",
      "--success",
      "--warning",
      "--info",
    ]) {
      expect(tokensCss).toContain(`${token}:`);
    }
  });

  it("defines the radius scale, spacing scale and panel layout tokens", () => {
    for (const token of [
      "--radius",
      "--radius-sm",
      "--radius-md",
      "--radius-lg",
      "--radius-xl",
      "--spacing",
      "--spacing-1",
      "--spacing-2",
      "--spacing-4",
      "--spacing-8",
      "--panel-width",
      "--panel-collapsed-width",
    ]) {
      expect(tokensCss).toContain(`${token}:`);
    }
  });

  it("is dark-mode-ready: .dark overrides plus a prefers-color-scheme fallback", () => {
    expect(tokensCss).toContain(".dark");
    expect(tokensCss).toContain("prefers-color-scheme: dark");
    expect(tokensCss).toContain(":root:not(.light)");
    // the dark set overrides the same core tokens
    const darkBlock = tokensCss.slice(tokensCss.indexOf(".dark"));
    expect(darkBlock).toContain("--background:");
    expect(darkBlock).toContain("--accent:");
  });

  it("documents that the final palette comes from workspace brand tokens (§7.5)", () => {
    expect(tokensCss).toContain("brand tokens");
  });

  it("contains no forbidden product names (§1.5)", () => {
    const lowered = tokensCss.toLowerCase();
    for (const forbidden of ["photocraft", "artcraft", "photoshop", "cursor"]) {
      expect(lowered).not.toContain(forbidden);
    }
  });
});

describe("Badge status map (§13.2 / §5.1 run states)", () => {
  it("maps non-terminal run phases to the running variant", () => {
    for (const status of ["planning", "executing", "rendering", "validating", "repairing"]) {
      expect(statusBadgeVariant(status)).toBe("running");
    }
  });

  it("maps terminal run states to succeeded / warning / failed / default", () => {
    expect(statusBadgeVariant("succeeded")).toBe("succeeded");
    expect(statusBadgeVariant("succeeded_with_warnings")).toBe("warning");
    expect(statusBadgeVariant("failed")).toBe("failed");
    expect(statusBadgeVariant("cancelled")).toBe("default");
    expect(statusBadgeVariant("queued")).toBe("default");
  });

  it("falls back to the neutral variant for unknown statuses", () => {
    expect(statusBadgeVariant("something-new")).toBe("default");
  });

  it("covers every status with a valid variant", () => {
    for (const variant of Object.values(STATUS_BADGE_VARIANT)) {
      expect([
        "default",
        "secondary",
        "outline",
        "running",
        "succeeded",
        "warning",
        "failed",
      ]).toContain(variant);
    }
  });
});
