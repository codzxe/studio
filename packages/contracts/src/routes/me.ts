// @studio/contracts — GET /v1/me (PRODUCT_ARCHITECTURE.md §7.2, §9.1).
// No request body; response shape only.

import type { PlanId } from "../models.js";
import type { Id, Role } from "./common.js";

/** One workspace membership row of `GET /v1/me`. */
export interface Membership {
  readonly workspaceId: Id;
  readonly role: Role;
  readonly workspace: {
    readonly id: Id;
    readonly name: string;
    readonly slug: string;
  };
}

/** Plan summary shown with the user (§10 billing dashboard). */
export interface PlanSummary {
  readonly plan: PlanId;
  readonly creditsBalance: number;
  readonly includedCredits: number;
  readonly renewsAt: string | null;
}

/** `GET /v1/me` → Ok<MeResponse>: user + memberships + plan summary. */
export interface MeResponse {
  readonly user: {
    readonly id: Id;
    readonly name: string | null;
    readonly email: string;
    /**
     * Staff role from better-auth (round 5): "admin" = platform admin — gates
     * the TOP pricing tier everywhere without a payment path; "user"/null for
     * regular accounts. The web onboarding uses it to skip the trial step.
     */
    readonly role: string | null;
  };
  readonly memberships: readonly Membership[];
  readonly plan: PlanSummary;
}
