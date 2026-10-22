/**
 * Workspace slug derivation (onboarding step 1, UI_DESIGN_SYSTEM.md §8.3).
 *
 * Must satisfy `WORKSPACE_SLUG_SCHEMA` (packages/contracts routes/workspaces.ts):
 * lowercase alnum + inner hyphens, 1-64 chars, alnum at both ends. Derived
 * live from the workspace name until the user edits the slug field directly.
 */

const MAX_SLUG_LENGTH = 64;

/**
 * Derive a URL-safe slug from a free-form name: lowercase, fold accents,
 * every non-alphanumeric run becomes one hyphen, trimmed at both ends and
 * clamped to the 64-char contract limit.
 */
export function slugify(name: string): string {
  const folded = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "");
  return folded
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
}
