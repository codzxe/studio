/**
 * Slug helpers for project URLs (`/w/{workspace}/p/{slug}`).
 * Lowercase ascii letters, digits and single dashes; bounded length.
 */
export function slugify(name) {
    const slug = name
        .toLowerCase()
        .normalize("NFKD")
        .replace(/\p{M}/gu, "") // strip combining marks (Ü→u, é→e)
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64)
        .replace(/-+$/g, "");
    return slug.length > 0 ? slug : "project";
}
/**
 * Deterministic uniqueness: appends `-2`, `-3`, … when the base slug (or its
 * numeric suffixes) is already taken. `taken` must contain the reserved slugs.
 */
export function ensureUniqueSlug(base, taken) {
    const stem = base.replace(/-(\d+)$/, "");
    const startSuffix = base === stem ? 1 : Number.parseInt(base.slice(stem.length + 1), 10);
    if (!taken.has(base))
        return base;
    for (let n = Math.max(2, startSuffix + 1); n < startSuffix + 1000; n += 1) {
        const candidate = `${stem}-${n}`;
        if (!taken.has(candidate))
            return candidate;
    }
    // pathological; caller treats conflict upstream
    return `${stem}-${Date.now()}`;
}
//# sourceMappingURL=slug.js.map