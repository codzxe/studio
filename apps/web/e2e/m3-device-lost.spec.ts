/**
 * M3 graphics-device-loss recovery — the e2e proof of the
 * `studio:deviceLost` handoff (docs/phases/M3.md "Known tails" #6): the REAL
 * dist's `js/host.js` `showDeviceLost` posts to the Studio parent when
 * embedded, and the parent recovers the session — save NOW through the real
 * autosave chain (real gateway upload), then reload the page so RSC
 * re-fetches the manifest and the editor reopens on a FRESH graphics device
 * WITH the just-saved work.
 *
 * M3 tail 6 (GPU circuit breaker): the recovery also arms the WebGL2
 * compatibility marker, so the reopened iframe boots
 * `/editor/?empty&gpu=webgl2&nogpuworkers` (the dist's no-adapter path:
 * WebGL2 context first, egui-wgpu on its WebGL backend, CPU-rendering
 * workers) instead of re-losing the same WebGPU device on every reload —
 * proven here end to end: reopen ON the compatibility URL, with the banner
 * that offers "Try WebGPU again".
 *
 * The device "loss" is simulated at the dist's own boundary — the exact
 * function the wasm device-lost callback calls — because a real GPU-process
 * kill is not deterministic on a test box; the contract under test is the
 * host↔page wiring and the save→reload→reopen journey, not Chrome's Dawn
 * internals. (Everything else is real: real sign-in, real editor wasm, real
 * gateway + sqlite, real version upload, real RSC re-fetch.)
 *
 * Same boot recipe as e2e/chat.spec.ts (e2e/README.md); no extra setup steps.
 */

import { type Page, expect, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Seeded world (packages/db/scripts/seed.ts — e2e/README.md §Seed)
// ---------------------------------------------------------------------------

const SEEDED_EMAIL = "demo@studio.test";
const SEEDED_PASSWORD = "demo-password-12345";
const SEEDED_EDITOR_PATH = "/w/demo-project/editor";

/** Wasm boot + manifest → project download → file.open. */
const EDITOR_OPEN_TIMEOUT_MS = 120_000;
/** The recovery save (bridge → gateway upload) + the reload. */
const RECOVERY_TIMEOUT_MS = 30_000;

/**
 * The frozen dist's JS-snippet module (the glue's own import path): the
 * committed tree pins `snippets/effectcraft-web-6247e0b7c298e283`, and the
 * whole repo (bridge docs, dist patching) pins this same dist.
 */
const HOST_JS_PATH = "/editor/snippets/effectcraft-web-6247e0b7c298e283/js/host.js";

/** The comp the recovery journey creates (its presence proves the save). */
const RECOVERY_COMP = "Recovery Check";

// ---------------------------------------------------------------------------
// Boot recipe (identical to e2e/chat.spec.ts)
// ---------------------------------------------------------------------------

async function waitForSignInHydration(page: Page): Promise<void> {
  const password = page.locator("#sign-in-password");
  const eyeToggle = page.locator(
    'button[aria-label="Show password"], button[aria-label="Hide password"]',
  );
  let hydrated = false;
  for (let i = 0; i < 30 && !hydrated; i += 1) {
    await eyeToggle.click();
    hydrated = (await password.getAttribute("type")) === "text";
    if (!hydrated) await page.waitForTimeout(1_000);
  }
  if (!hydrated) {
    throw new Error("sign-in form never hydrated (eye-toggle canary timed out)");
  }
  // Restore the hidden-password state the recipe expects.
  await eyeToggle.click();
}

async function openSeededEditor(page: Page): Promise<void> {
  const attemptSignIn = async (): Promise<void> => {
    await page.goto(`/sign-in?next=${encodeURIComponent(SEEDED_EDITOR_PATH)}`);
    await waitForSignInHydration(page);
    await page.locator("#sign-in-email").fill(SEEDED_EMAIL);
    await page.locator("#sign-in-password").fill(SEEDED_PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL(`**${SEEDED_EDITOR_PATH}`, { timeout: 20_000 });
  };
  try {
    await attemptSignIn();
  } catch {
    await attemptSignIn();
  }

  await expect(page.getByTestId("editor-host")).toHaveAttribute("data-editor-phase", "open", {
    timeout: EDITOR_OPEN_TIMEOUT_MS,
  });
  await expect(page.getByTestId("editor-iframe")).toBeVisible();
}

/** The editor iframe's frame (the only frame under /editor/). */
function editorFrame(page: Page) {
  const frame = page.frames().find((f) => f.url().includes("/editor/"));
  if (frame === undefined) {
    throw new Error("editor iframe not found");
  }
  return frame;
}

type EffectcraftGlobal = {
  request: (method: string, params?: unknown) => Promise<unknown>;
  execute: (command: string, params?: unknown) => Promise<unknown>;
};

// ---------------------------------------------------------------------------
// The journey
// ---------------------------------------------------------------------------

test.describe("M3 device-lost recovery — studio:deviceLost → save → reload → reopen", () => {
  test.beforeEach(() => {
    // A wasm editor boot (up to 120 s) + the recovery save + a SECOND full
    // boot after the reload — the same budget the sibling editor suites set.
    test.setTimeout(300_000);
  });

  test("the embedded dist reports the loss; the host saves and reopens with the work kept", async ({
    page,
  }) => {
    await openSeededEditor(page);

    // 1. An edit through the REAL engine (the dist's control channel):
    //    comp.new is an undoable edit → project.dirty true → the recovery
    //    save will have something to upload.
    await editorFrame(page).evaluate(
      (name) =>
        (window as unknown as { effectcraft: EffectcraftGlobal }).effectcraft.execute("comp.new", {
          name,
          open: false,
        }),
      RECOVERY_COMP,
    );

    // Arm the reload watcher FIRST: the recovery's save → upload → reload can
    // complete within milliseconds on the local stack, and any evaluate-based
    // canary would race the navigation ("execution context destroyed"). The
    // document request for the editor route is the reload itself.
    const reloadNavigation = page.waitForRequest(
      (req) =>
        req.isNavigationRequest() &&
        req.method() === "GET" &&
        new URL(req.url()).pathname === SEEDED_EDITOR_PATH,
      { timeout: RECOVERY_TIMEOUT_MS },
    );

    // 2. The device loss, at the dist's own boundary: the exact function the
    //    wasm device-lost callback calls. Embedded (parent ≠ window) it
    //    posts studio:deviceLost to the Studio parent — same origin.
    await editorFrame(page).evaluate(async (hostPath) => {
      const host = (await import(hostPath)) as {
        showDeviceLost: (message: string, kept: boolean) => void;
      };
      host.showDeviceLost(
        "GPU device lost (Unknown): A valid external Instance reference no longer exists (e2e)",
        false,
      );
    }, HOST_JS_PATH);

    // 3. The recovery overlay owns the page while the save runs. (The copy
    //    assertion is deliberately NOT here: on this box the local gateway
    //    uploads in milliseconds, the reload races any second query, and the
    //    overlay's existence + the journey below are the contract.)
    await expect(page.getByTestId("device-lost-overlay")).toBeVisible({
      timeout: RECOVERY_TIMEOUT_MS,
    });

    // 4. The save lands (real gateway upload) and the page reloads — the
    //    armed navigation request fires.
    await reloadNavigation;

    // 5. The editor reopens (fresh wasm boot) — and the edit survived the
    //    device loss: the recovery save's version reopens with the comp.
    await expect(page.getByTestId("editor-host")).toHaveAttribute("data-editor-phase", "open", {
      timeout: EDITOR_OPEN_TIMEOUT_MS,
    });
    // M3 tail 6: it reopens on the WebGL2 COMPATIBILITY boot — the recovery
    // armed the GPU circuit breaker, so this reload cannot loop on the same
    // dying WebGPU device (the field report: "A valid external Instance
    // reference no longer exists").
    await expect(page.getByTestId("editor-iframe")).toHaveAttribute(
      "src",
      "/editor/?empty&gpu=webgl2&nogpuworkers",
    );
    await expect(page.getByTestId("editor-gpu-fallback-banner")).toBeVisible();
    const items = await editorFrame(page).evaluate(async () => {
      // query commands (project.summary) ride the execute channel — the
      // bridge's own `query()` maps onto `effectcraft.execute` (bridge.ts).
      const summary = (await (
        window as unknown as { effectcraft: EffectcraftGlobal }
      ).effectcraft.execute("project.summary", {})) as { items?: Array<{ name?: string }> };
      return (summary.items ?? []).map((item) => String(item.name ?? ""));
    });
    expect(items).toContain(RECOVERY_COMP);
  });
});
