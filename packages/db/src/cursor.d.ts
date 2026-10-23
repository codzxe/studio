/**
 * Opaque keyset cursor: base64url(JSON `{ t: ISO, id }`).
 * Sorting is (createdAt DESC, id DESC); the cursor encodes the last item.
 */
export interface Cursor {
    readonly t: string;
    readonly id: string;
}
export declare function encodeCursor(cursor: Cursor): string;
export declare function decodeCursor(raw: string | undefined | null): Cursor | null;
export interface Page<T> {
    readonly items: readonly T[];
    readonly nextCursor: string | null;
}
/** Default page size for repo list methods. */
export declare const DEFAULT_PAGE_SIZE = 20;
export declare const MAX_PAGE_SIZE = 100;
export declare function clampLimit(limit?: number): number;
