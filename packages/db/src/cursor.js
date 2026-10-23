import { DbError } from "./errors-lite.js";
export function encodeCursor(cursor) {
    const json = JSON.stringify(cursor);
    return Buffer.from(json, "utf8").toString("base64url");
}
export function decodeCursor(raw) {
    if (!raw)
        return null;
    let parsed;
    try {
        const json = Buffer.from(raw, "base64url").toString("utf8");
        parsed = JSON.parse(json);
    }
    catch {
        throw DbError.validation("Invalid pagination cursor");
    }
    if (typeof parsed === "object" &&
        parsed !== null &&
        typeof parsed.t === "string" &&
        typeof parsed.id === "string") {
        const { t, id } = parsed;
        return { t, id };
    }
    throw DbError.validation("Invalid pagination cursor");
}
/** Default page size for repo list methods. */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
export function clampLimit(limit) {
    if (limit === undefined)
        return DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1) {
        throw DbError.validation("limit must be a positive integer");
    }
    return Math.min(limit, MAX_PAGE_SIZE);
}
//# sourceMappingURL=cursor.js.map