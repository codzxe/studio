// @studio/gateway — lease-guard (BUILD_PLAN §M7 task 3: "Read-only mode blocks
// mutations at the API"; PRODUCT_ARCHITECTURE §11: "Viewers can open the editor
// read-only; they see the same UI but writes are blocked by the lease and the
// gateway").
//
// THE M7 READ-ONLY RULE — a project under an ACTIVE single-writer lease accepts
// mutations ONLY from its holder; everyone else edits read-only. The guard is
// a no-op when the lease is free, absent or EXPIRED (lazily-dead rows never
// block — the next acquire steals them via the atomic upsert).
//
// D-23 (read-only scope): the block covers PROJECT mutations only — chat (and
// the comment surface) stays ALLOWED for non-holders, because per ECUX §4.1
// the agent may look and propose in read-only mode; only APPLY (and the other
// project writes) is blocked. routes/chat.ts is therefore NOT wired here.

import type { AppContext, GatewayDeps } from "./context.js";
import { GatewayError } from "./errors.js";

/**
 * Resolve a member's display name for UI copy. Law #1: never ids in copy —
 * an unknown or nameless member renders as "Someone", not as their user id.
 */
export function memberDisplayName(c: AppContext, userId: string): string {
  const member = c.get("workspace").members.find((entry) => entry.userId === userId);
  const name = member?.userName;
  return typeof name === "string" && name.trim() !== "" ? name.trim() : "Someone";
}

/**
 * The M7 read-only enforcement gate for project-scoped mutations.
 *
 * Throws **409 LEASE_HELD** (catalog message shape: "{Name} is editing this
 * project right now.") when an ACTIVE lease exists for the project and its
 * holder is not the caller. Cross-tenant and unknown project ids surface as
 * **404** through the repo's tenant filter (law #3 — the guard calls
 * `leases.get(workspaceId, projectId)` first). Free/expired/own leases pass.
 *
 * Wire it into the handler AFTER the caller's workspace is resolved and BEFORE
 * the first state-changing call; the thrown envelope carries the holder's
 * display NAME (never their id) so the client banner can say who is editing.
 */
export async function requireLeaseForMutation(
  deps: GatewayDeps,
  c: AppContext,
  projectId: string,
): Promise<void> {
  const snapshot = await deps.repos.leases.get(c.get("workspace").id, projectId);
  if (snapshot === null || !snapshot.isHeld) {
    return; // no lease row, or an expired one — nothing blocks the write
  }
  if (snapshot.lease.userId === c.get("auth").user.id) {
    return; // the holder is the caller — mutations are theirs (§9.3)
  }
  const holderName = memberDisplayName(c, snapshot.lease.userId);
  throw new GatewayError("LEASE_HELD", `${holderName} is editing this project right now.`, {
    status: 409,
    hint: "Open the project read-only, or request edit access and take over when the current editor is done.",
    retryable: true,
    requestId: c.get("requestId"),
  });
}
