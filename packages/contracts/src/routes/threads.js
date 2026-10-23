// @studio/contracts — chat threads (PRODUCT_ARCHITECTURE.md §7.2, §9.1).
import { z } from "zod";
import { ID_SCHEMA } from "./common.js";
export const THREAD_TITLE_SCHEMA = z.string().max(200);
/** `POST /v1/projects/:id/threads` body (projectId in path). */
export const CREATE_THREAD_SCHEMA = z.strictObject({
    title: THREAD_TITLE_SCHEMA.optional(),
});
export const THREAD_MESSAGE_ROLE_SCHEMA = z.enum(["user", "assistant", "system"]);
export const THREAD_ID_SCHEMA = ID_SCHEMA;
//# sourceMappingURL=threads.js.map