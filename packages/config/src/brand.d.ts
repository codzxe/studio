/**
 * Brand tokens. Treat every field as the single source of truth for its concept;
 * rename the product by editing this const (and nothing else).
 */
export interface BrandTokens {
    /** Internal codename used in logs, CI and docs (safe to expose anywhere). */
    readonly codename: string;
    /** User-facing product name. This is the one token the final rename swaps. */
    readonly productName: string;
    /** `<title>` family: product name — tagline. */
    readonly titleTag: string;
    /** Landing hero headline (docs/UI_DESIGN_SYSTEM.md §8.1). */
    readonly tagline: string;
    /** One-sentence hero subline. Voice: concise, confident, specific; no hype. */
    readonly heroSubline: string;
    /**
     * Names that must never appear in user-facing copy (ADR-0006 brand rule).
     * Checked by {@link assertBrandSafe} for future CI lint over UI strings.
     */
    readonly forbiddenNames: readonly string[];
    /** Placeholder domain tokens; swapped with the product name when final. */
    readonly domains: {
        /** Marketing / landing site host. */
        readonly marketing: string;
        /** Signed-in SaaS app host (APP_URL family). */
        readonly app: string;
        /** Documentation host. */
        readonly docs: string;
        /** Status page host. */
        readonly status: string;
    };
    /** Contact tokens used across the app, emails and security.txt. */
    readonly contact: {
        /** General hello/from address. */
        readonly email: string;
        /** Support inbox (support@…). */
        readonly support: string;
        /** Security disclosure inbox (security@…). */
        readonly security: string;
    };
    /** Social profile tokens (final URLs resolved after naming). */
    readonly social: {
        readonly x: string;
        readonly github: string;
        readonly youtube: string;
    };
}
/** Single swap point for the product name and every brand token. */
export declare const Brand: BrandTokens;
/**
 * Forbidden brand names found in `text` (matched names, e.g. `["Photoshop"]`).
 * Intended for commercial UI copy only — attribution files and licences pages
 * legitimately mention the upstream marks and are not run through this check.
 */
export declare function brandViolations(text: string): string[];
/**
 * Brand-safety gate for CI lint: `true` when `text` is free of the forbidden
 * upstream/tool names (ADR-0006). See {@link brandViolations} for match rules.
 */
export declare function assertBrandSafe(text: string): boolean;
