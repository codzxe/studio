import { eq } from "drizzle-orm";

import type { StudioDb } from "../db.js";
import { DbError } from "../errors-lite.js";
import type { UserSettings } from "../schema.js";
import { tablesFor } from "../tables.js";
import { requireNonEmpty } from "./shared.js";

/**
 * Per-USER settings repository (NOT workspace-scoped by design — §M6/M5-O:
 * auto-apply is a personal trust preference, not a workspace entitlement; the
 * apply route still enforces it server-side for the acting user).
 *
 * Round-10 v2: `autoApplyEnabled` is ON by default — the agent executes
 * reversible plans itself and the user opts OUT in Settings (the product
 * owner's ruling: an agent that only writes plans is useless). A missing
 * row therefore reads as TRUE (the schema default); an explicit false row
 * from a user who toggled it off always wins.
 */

export interface SettingsRepo {
  /** auto-apply flag; TRUE when the user has no settings row yet (the default). */
  getUserAutoApply(userId: string): Promise<boolean>;
  /** Upsert the flag; unknown user reads as NOT_FOUND. */
  setUserAutoApply(userId: string, enabled: boolean): Promise<UserSettings>;
}

export function createSettingsRepo(db: StudioDb): SettingsRepo {
  // Dialect-aware tables (W3-A, tables.ts seam) — see createProjectsRepo.
  const { user, userSettings } = tablesFor(db);
  return {
    async getUserAutoApply(userId) {
      requireNonEmpty(userId, "userId");
      const [row] = await db
        .select({ autoApplyEnabled: userSettings.autoApplyEnabled })
        .from(userSettings)
        .where(eq(userSettings.userId, userId))
        .limit(1);
      // absent row = the schema default = true (agent does the work until opt-out)
      return row?.autoApplyEnabled ?? true;
    },

    async setUserAutoApply(userId, enabled) {
      const id = requireNonEmpty(userId, "userId");

      const [actor] = await db.select({ id: user.id }).from(user).where(eq(user.id, id)).limit(1);
      if (!actor) throw DbError.notFound("user");

      const [row] = await db
        .insert(userSettings)
        .values({ userId: id, autoApplyEnabled: enabled })
        .onConflictDoUpdate({
          target: userSettings.userId,
          set: { autoApplyEnabled: enabled, updatedAt: new Date() },
        })
        .returning();
      if (!row) throw DbError.conflict("Could not update user settings");
      return row;
    },
  };
}
