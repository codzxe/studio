import { eq } from "drizzle-orm";
import { DbError } from "../errors-lite.js";
import { user, userSettings } from "../schema.js";
import { requireNonEmpty } from "./shared.js";
export function createSettingsRepo(db) {
    return {
        async getUserAutoApply(userId) {
            requireNonEmpty(userId, "userId");
            const [row] = await db
                .select({ autoApplyEnabled: userSettings.autoApplyEnabled })
                .from(userSettings)
                .where(eq(userSettings.userId, userId))
                .limit(1);
            // absent row = the schema default = false (off until opt-in)
            return row?.autoApplyEnabled ?? false;
        },
        async setUserAutoApply(userId, enabled) {
            const id = requireNonEmpty(userId, "userId");
            const [actor] = await db.select({ id: user.id }).from(user).where(eq(user.id, id)).limit(1);
            if (!actor)
                throw DbError.notFound("user");
            const [row] = await db
                .insert(userSettings)
                .values({ userId: id, autoApplyEnabled: enabled })
                .onConflictDoUpdate({
                target: userSettings.userId,
                set: { autoApplyEnabled: enabled, updatedAt: new Date() },
            })
                .returning();
            if (!row)
                throw DbError.conflict("Could not update user settings");
            return row;
        },
    };
}
//# sourceMappingURL=settings.js.map