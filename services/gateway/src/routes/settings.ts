// @studio/gateway — GET/PATCH /v1/me/settings (§7.2, W3-G2): the account-level
// preferences seam behind the M9 settings surface's Models page auto-apply
// toggle (D-22: "Apply is always your explicit click" — the flag defaults OFF
// and is enforced server-side by the chat route's auto-apply gate, not by the
// client).
//
// requireAuth only — NO workspace context: the row is per USER (the db repo
// lives in `user_settings` and is absent until the first PATCH; an absent row
// reads as the schema default, false — off until opt-in). Zod at the boundary:
// PATCH bodies parse SETTINGS_PATCH_SCHEMA (strict boolean-only) before the
// repo is touched; responses are the SettingsResponse echo of the stored flag.
//
// Stub-boot degrade (same guard as routes/me.ts + chat.ts's auto-apply seam):
// fake-repos boots (tests/helpers.fakeRepos) wire no settings repo — a GET
// then degrades to the documented default `false` (identical to the absent-row
// read, never a crash), while a PATCH fails with the typed SERVICE_UNAVAILABLE
// envelope rather than writing a preference the deployment cannot persist.
// Production wires the real repo (createRepos) — this path is harness-only.

import { Hono } from "hono";

import { SETTINGS_PATCH_SCHEMA, type SettingsResponse } from "@studio/contracts";
import type { Repos } from "@studio/db";

import type { AppBindings, AppContext, GatewayDeps } from "../context.js";
import { GatewayError } from "../errors.js";
import { ok } from "../http.js";
import { requireAuth } from "../middleware.js";

/** Stub boots wire fake repos without the user_settings table; absence is harness-only. */
function settingsRepo(repos: Repos): Repos["settings"] | null {
  const candidate = (repos as Repos & { settings?: Repos["settings"] }).settings;
  if (candidate === undefined || typeof candidate.setUserAutoApply !== "function") return null;
  return candidate;
}

export function settingsRoutes(deps: GatewayDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("/v1/me/settings", requireAuth());

  // -- GET /v1/me/settings — the signed-in user's preferences ----------------
  app.get("/v1/me/settings", async (c: AppContext): Promise<Response> => {
    const settings = settingsRepo(deps.repos);
    const autoApplyEnabled =
      settings === null ? false : await settings.getUserAutoApply(c.get("auth").user.id);
    const body: SettingsResponse = { autoApplyEnabled };
    return ok(c, body);
  });

  // -- PATCH /v1/me/settings — upsert (echoes the stored value) --------------
  app.patch("/v1/me/settings", async (c: AppContext): Promise<Response> => {
    const requestId = c.get("requestId");
    const settings = settingsRepo(deps.repos);
    if (settings === null) {
      throw new GatewayError("SERVICE_UNAVAILABLE", "Settings aren't available right now.", {
        status: 503,
        hint: "Try again in a moment.",
        requestId,
      });
    }

    const parsed = SETTINGS_PATCH_SCHEMA.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new GatewayError("VALIDATION_FAILED", "That request didn't look right.", {
        status: 400,
        hint: "Send autoApplyEnabled as true or false.",
        requestId,
      });
    }

    const row = await settings.setUserAutoApply(
      c.get("auth").user.id,
      parsed.data.autoApplyEnabled,
    );
    const body: SettingsResponse = { autoApplyEnabled: row.autoApplyEnabled };
    return ok(c, body);
  });

  return app;
}
