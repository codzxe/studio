// @studio/contracts — /v1/workspaces/:id/invites + /v1/invites/:token/accept
// (PRODUCT_ARCHITECTURE.md §7.2, §7.1 — roles are wire-stable, every invite is audited).
import { z } from "zod";
import { ID_SCHEMA, ROLE_SCHEMA } from "./common.js";
/** `POST /v1/workspaces/:id/invites` body. */
export const INVITE_MEMBER_SCHEMA = z.strictObject({
    email: z.email(),
    role: ROLE_SCHEMA,
});
/** `POST /v1/invites/:token/accept` has no body (token in path). */
export const ACCEPT_INVITE_SCHEMA = z.strictObject({});
export const INVITE_ID_SCHEMA = ID_SCHEMA;
//# sourceMappingURL=invites.js.map