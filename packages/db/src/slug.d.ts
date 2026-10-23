/**
 * Slug helpers for project URLs (`/w/{workspace}/p/{slug}`).
 * Lowercase ascii letters, digits and single dashes; bounded length.
 */
export declare function slugify(name: string): string;
/**
 * Deterministic uniqueness: appends `-2`, `-3`, … when the base slug (or its
 * numeric suffixes) is already taken. `taken` must contain the reserved slugs.
 */
export declare function ensureUniqueSlug(base: string, taken: ReadonlySet<string>): string;
