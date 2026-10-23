// @studio/contracts — user settings (W3-G3, §7.2): GET/PATCH /v1/me/settings.
//
// The M9 settings surface's account-level seam. `autoApplyEnabled` is the
// user's agent-run auto-apply preference. requireAuth only — no workspace
// context: the flag is per USER (the db row lives in `user_settings` and is
// absent until the first PATCH; absent reads as false — off until opt-in).

import { z } from "zod";

/** `GET /v1/me/settings` response (and the PATCH echo). */
export interface SettingsResponse {
  readonly autoApplyEnabled: boolean;
}

/** Zod mirror of SettingsResponse (response validation, api-client). */
export const SETTINGS_RESPONSE_SCHEMA = z.object({
  autoApplyEnabled: z.boolean(),
});

/** `PATCH /v1/me/settings` body — the upsert payload (strict: boolean only). */
export const SETTINGS_PATCH_SCHEMA = z.strictObject({
  autoApplyEnabled: z.boolean(),
});

export type SettingsPatchRequest = z.infer<typeof SETTINGS_PATCH_SCHEMA>;
