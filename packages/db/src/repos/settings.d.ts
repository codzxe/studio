import type { StudioDb } from "../db.js";
import { type UserSettings } from "../schema.js";
/**
 * Per-USER settings repository (NOT workspace-scoped by design — §M6/M5-O:
 * auto-apply is a personal trust preference, not a workspace entitlement; the
 * apply route still enforces it server-side for the acting user).
 *
 * `autoApplyEnabled` is OFF by default: agent edits stay propose-only until
 * the user explicitly opts in (BUILD_PLAN M5 auto-apply policy seam, M5-O).
 * The DEFAULT lives in the schema column so a missing row reads as false.
 */
export interface SettingsRepo {
    /** auto-apply flag; false when the user has no settings row yet (the default). */
    getUserAutoApply(userId: string): Promise<boolean>;
    /** Upsert the flag; unknown user reads as NOT_FOUND. */
    setUserAutoApply(userId: string, enabled: boolean): Promise<UserSettings>;
}
export declare function createSettingsRepo(db: StudioDb): SettingsRepo;
