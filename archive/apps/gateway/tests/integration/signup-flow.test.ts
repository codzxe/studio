// W4-P — §20 #1 (partial): "A new user signs up, creates a workspace, and
// invites a second member with an editor role; the member sees the same
// project list."
//
// What this suite covers end-to-end through the REAL workspace/invite/document/
// runs routers (fake auth-provider sessions only — no Better Auth server, no
// email):
//   workspace create → owner member row exists → trial grant lands in the
//   REAL ledger → invite (role editor) → accept → member row with role editor
//   → the member lists the SAME project list → the new member can start a run
//   on it (editor) while the invite token burns to 409.
// The signup/email-verification itself (Better Auth + email wave) is out of
// scope here — this pins the workspace/membership/invite semantics the
// criterion is really about.

import { describe, expect, it } from "vitest";
import { trialGrantKey } from "@studio/billing";
import {
  buildGateway,
  postJson,
  TOKENS,
  USERS,
  type ErrorEnvelope,
  type GatewayHarness,
} from "./harness.js";

interface CreateWorkspaceResponse {
  readonly workspace: { readonly id: string; readonly name: string; readonly slug: string };
  readonly role: string;
  readonly trial: { readonly granted: boolean; readonly credits: number; readonly duplicate: boolean };
}

interface InviteResponse {
  readonly invite: {
    readonly token: string;
    readonly organization_id: string;
    readonly email: string;
    readonly role: string;
    readonly status: string;
  };
}

interface MembersResponse {
  readonly members: { id: string; user_id: string; role: string }[];
}

describe("§20 #1 — signup → workspace → owner member → invite → editor member", () => {
  it("walks the full flow with a fake auth-provider session", async () => {
    const h: GatewayHarness = buildGateway({ seedWorkspaces: false });

    // -- 1. A new user creates a workspace (§13.1 POST /v1/workspaces). -----
    const create = await postJson(h, "/v1/workspaces", { name: "Acme Atelier" }, TOKENS.signupOwner);
    expect(create.status).toBe(201);
    const created = (await create.json()) as CreateWorkspaceResponse;
    const workspaceId = created.workspace.id;
    expect(created.role).toBe("owner");
    expect(created.workspace.name).toBe("Acme Atelier");

    // -- 2. The OWNER member row exists (direct store + through the API). --
    const ownerRow = await h.wsDb.findMembership(USERS.signupOwner, workspaceId);
    expect(ownerRow?.role).toBe("owner");

    // The owner's session now points at their new workspace.
    h.setSessionOrg(TOKENS.signupOwner, workspaceId);

    const membersAsOwner = (await (
      await h.app.request(`/v1/workspaces/${workspaceId}/members`, {
        method: "GET",
        headers: { authorization: `Bearer ${TOKENS.signupOwner}` },
      })
    ).json()) as MembersResponse;
    expect(membersAsOwner.members.map((m) => m.user_id)).toEqual([USERS.signupOwner]);
    expect(membersAsOwner.members[0]?.role).toBe("owner");

    // -- 3. §1.4/§14.1: the one-time trial grant landed in the REAL ledger --
    // (idempotency key trial-grant:<orgId>, §14.2 rule 6).
    expect(created.trial).toEqual({ granted: true, credits: 30, duplicate: false });
    const grants = h.ledger.entriesOfKind("grant", workspaceId);
    expect(grants).toHaveLength(1);
    expect(grants[0]?.delta).toBe(30);
    expect(grants[0]?.idempotencyKey).toBe(trialGrantKey(workspaceId));

    // -- 4. The owner seeds a project so the list has something to share. --
    const doc = await postJson(
      h,
      "/v1/documents",
      { name: "Founders Day poster", width: 1080, height: 1080 },
      TOKENS.signupOwner,
    );
    expect(doc.status).toBe(201);
    const docBody = (await doc.json()) as { document: { id: string } };

    // -- 5. The owner invites a second member with the EDITOR role (§13.1). --
    const invite = await postJson(
      h,
      `/v1/workspaces/${workspaceId}/invites`,
      { email: "second@example.test", role: "editor" },
      TOKENS.signupOwner,
    );
    expect(invite.status).toBe(201);
    const inviteBody = (await invite.json()) as InviteResponse;
    expect(inviteBody.invite.role).toBe("editor");
    expect(inviteBody.invite.status).toBe("pending");
    expect(inviteBody.invite.organization_id).toBe(workspaceId);

    // -- 6. The invitee accepts (fake auth session; the token is the
    //       capability until the email wave lands — TODO(email) in W4-E). --
    const accept = await h.app.request(`/v1/invites/${inviteBody.invite.token}/accept`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKENS.signupInvitee}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(accept.status).toBe(200);
    const accepted = (await accept.json()) as { workspace_id: string; role: string };
    expect(accepted.workspace_id).toBe(workspaceId);
    expect(accepted.role).toBe("editor");

    // -- 7. The member row exists with role EDITOR (store + API view). ----
    const memberRow = await h.wsDb.findMembership(USERS.signupInvitee, workspaceId);
    expect(memberRow?.role).toBe("editor");

    const membersNow = (await (
      await h.app.request(`/v1/workspaces/${workspaceId}/members`, {
        method: "GET",
        headers: { authorization: `Bearer ${TOKENS.signupOwner}` },
      })
    ).json()) as MembersResponse;
    const inviteeMember = membersNow.members.find((m) => m.user_id === USERS.signupInvitee);
    expect(inviteeMember?.role).toBe("editor");

    // The invite is consumed (§13.1 status machine).
    const inviteRow = h.wsDb.invitations.find((i) => i.id === inviteBody.invite.token);
    expect(inviteRow?.status).toBe("accepted");

    // -- 8. The member sees the SAME project list (§20 #1). ----------------
    // The accepted membership drives the session's tenant + role now.
    h.addSession(TOKENS.signupInvitee, {
      userId: USERS.signupInvitee,
      email: "second@example.test",
      organizationId: workspaceId,
      role: "editor",
    });

    const memberWorkspaces = (await (
      await h.app.request("/v1/workspaces", {
        method: "GET",
        headers: { authorization: `Bearer ${TOKENS.signupInvitee}` },
      })
    ).json()) as { workspaces: { id: string; role: string }[] };
    expect(memberWorkspaces.workspaces.map((w) => w.id)).toEqual([workspaceId]);
    expect(memberWorkspaces.workspaces[0]?.role).toBe("editor");

    const memberDocs = (await (
      await h.app.request("/v1/documents", {
        method: "GET",
        headers: { authorization: `Bearer ${TOKENS.signupInvitee}` },
      })
    ).json()) as { documents: { id: string; name: string }[] };
    expect(memberDocs.documents.map((d) => d.id)).toEqual([docBody.document.id]);
    expect(memberDocs.documents[0]?.name).toBe("Founders Day poster");

    // -- 9. The new member can work on the shared project (editor runs). ----
    const run = await postJson(
      h,
      "/v1/runs",
      { documentId: docBody.document.id, prompt: "warm and cozy promo", tier: "quick" },
      TOKENS.signupInvitee,
      { "idempotency-key": "signup-member-run" },
    );
    expect(run.status).toBe(201);
    const runBody = (await run.json()) as { run_id: string; credits_reserved: number };
    expect(runBody.credits_reserved).toBeGreaterThan(0);
    // The member's run spends the workspace's trial credits — one shared pot.
    expect(await h.ledger.balanceAfter(workspaceId)).toBe(30 - runBody.credits_reserved);

    // -- 10. The burned invite cannot be replayed (§3.4-style idempotent
    //        consumption): view + accept both answer 409. -------------------
    const reView = await h.app.request(`/v1/invites/${inviteBody.invite.token}`, {
      method: "GET",
      headers: { authorization: `Bearer ${TOKENS.signupInvitee}` },
    });
    expect(reView.status).toBe(409);
    expect(((await reView.json()) as ErrorEnvelope).code).toBe("invite_unusable");

    const reAccept = await h.app.request(`/v1/invites/${inviteBody.invite.token}/accept`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKENS.signupInvitee}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(reAccept.status).toBe(409);
    expect(h.wsDb.memberships.filter((m) => m.organizationId === workspaceId)).toHaveLength(2);

    // -- 11. §22: the audit trail recorded the whole flow, correlated to the
    //         workspace (workspace.created, member.created, invite.created,
    //         invite.accepted — request ids threaded by the routes). --------
    const actions = h.wsAudit.entries
      .filter((entry) => entry.organizationId === workspaceId)
      .map((entry) => entry.action);
    expect(actions).toContain("workspace.created");
    expect(actions).toContain("member.created");
    expect(actions).toContain("invite.created");
    expect(actions).toContain("invite.accepted");
  });

  it("a workspace is granted exactly one trial — the ledger key is the backstop", async () => {
    const h = buildGateway({ seedWorkspaces: false });
    const first = await postJson(h, "/v1/workspaces", { name: "One Shot" }, TOKENS.signupOwner);
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as CreateWorkspaceResponse;
    expect(firstBody.trial.credits).toBe(30);

    // §14.2 rule 6: the grant's idempotency key is per-workspace
    // (trial-grant:<orgId>) — a double-clicked signup or replayed request can
    // never mint trial credits twice for the same workspace.
    expect(h.ledger.entriesOfKind("grant", firstBody.workspace.id)).toHaveLength(1);
    expect(await h.ledger.balanceAfter(firstBody.workspace.id)).toBe(30);
  });
});
