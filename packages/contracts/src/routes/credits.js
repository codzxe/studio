// @studio/contracts — credits (PRODUCT_ARCHITECTURE.md §7.2, §8.8, §9.1 `credit_ledger`).
import { z } from "zod";
import { PAGINATION_QUERY_SCHEMA } from "./common.js";
/** Ledger entry kinds (§9.1 `credit_ledger.kind`): grant|reserve|commit|refund|adjust. */
export const LEDGER_KINDS = [
    "grant",
    "reserve",
    "commit",
    "refund",
    "adjust",
];
export const LEDGER_KIND_SCHEMA = z.enum(LEDGER_KINDS);
/** `GET /v1/credits/ledger` query (append-only log, cursor-paginated). */
export const LEDGER_QUERY_SCHEMA = PAGINATION_QUERY_SCHEMA;
//# sourceMappingURL=credits.js.map