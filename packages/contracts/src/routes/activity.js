// @studio/contracts — activity feed (PRODUCT_ARCHITECTURE.md §7.2, §9.1 `audit_log`).
//
// `GET /v1/projects/:id/activity`: project-scoped feed of audited actions.
// Every role change, invite, API-key create/revoke and destructive action is
// audited (§7.1); this is the user-facing view, not the compliance log.
import { PAGINATION_QUERY_SCHEMA } from "./common.js";
/** `GET /v1/projects/:id/activity` query. */
export const ACTIVITY_QUERY_SCHEMA = PAGINATION_QUERY_SCHEMA;
//# sourceMappingURL=activity.js.map