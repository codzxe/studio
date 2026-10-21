"use client";

// Invite acceptance card (W8-B; §20 #1 — sign-up → workspace → invite flow).
//
// /invite/:token where `token` is the Better Auth organization invitation id
// carried by the invite email's link. Real organization-plugin calls
// (apps/gateway/src/auth/server.ts mounts the plugin; both endpoints below
// also 401 without a session and 400 once an invite stops being pending):
//  - `organization.getInvitation({ query: { id } })` — org/invite info:
//    organizationName, role, inviterEmail, status (fields verified against
//    better-auth 1.1–1.6 dists; until the gateway wave mounts /api/auth the
//    fetch surfaces its typed error below);
//  - `organization.acceptInvitation({ invitationId })` — flips the invite to
//    accepted, creates the member row AND activates the joined workspace on
//    the session server-side, so /dashboard opens straight into it.
// Signed-out visitors get sign-in/sign-up CTAs that round-trip through
// ?next=/invite/:token; a signed-in non-recipient gets the gateway's typed
// FORBIDDEN error. React Query is the server-state layer (src/app/
// providers.tsx).

import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { AuthError } from "@/app/(auth)/components/auth-error";
import { authClient, POST_AUTH_PATH, toAuthFormError, type AuthFormError } from "@/lib/auth";

// Zod at every boundary: the plugin payload is typed from the client plugins
// alone (see the typing notes in src/lib/auth.ts), so parse defensively and
// degrade to placeholders rather than trusting the inferred shape.
const invitationInfoSchema = z
  .object({
    id: z.string().min(1),
    email: z.string().nullish(),
    role: z.string().nullish(),
    status: z.string().nullish(),
    organizationName: z.string().nullish(),
    organizationSlug: z.string().nullish(),
    inviterEmail: z.string().nullish(),
    expiresAt: z.string().nullish(),
  })
  .passthrough();

interface InvitationInfo {
  readonly id: string;
  readonly email: string | null;
  readonly role: string | null;
  readonly status: string | null;
  readonly organizationName: string | null;
  readonly organizationSlug: string | null;
  readonly inviterEmail: string | null;
  readonly expiresAt: string | null;
}

// §15.2 role ladder, one line each — the badge shows the role, this explains it.
const ROLE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  owner: "Full control of the workspace, including billing and deletion.",
  admin: "Manage members, billing and invites.",
  editor: "Run the agent and edit documents.",
  viewer: "View and comment on documents.",
};

function describeRole(role: string | null): string {
  if (role === null) {
    return "Member of the workspace.";
  }
  return ROLE_DESCRIPTIONS[role] ?? "Member of the workspace.";
}

function displayRole(role: string | null): string {
  if (role === null || role.length === 0) {
    return "member";
  }
  return `${role.charAt(0).toUpperCase()}${role.slice(1)}`;
}

// TODO(branding): "Layerly" is the temporary neutral working name (W1-K);
// the (app) group has no layout yet, so this card carries its own chrome.
const SITE_NAME = "Layerly";

export function AcceptInviteCard({ token }: { readonly token: string }) {
  const router = useRouter();
  const session = authClient.useSession();
  const invitePath = `/invite/${encodeURIComponent(token)}`;

  const invitation = useQuery<InvitationInfo, AuthFormError>({
    queryKey: ["auth", "invitation", token],
    enabled: !session.isPending && session.data !== null,
    retry: false,
    queryFn: async () => {
      const { data, error } = await authClient.organization.getInvitation({
        query: { id: token },
      });
      if (error !== null && error !== undefined) {
        throw toAuthFormError(error);
      }
      const parsed = invitationInfoSchema.safeParse(data);
      if (!parsed.success) {
        const failure: AuthFormError = {
          code: "unexpected_response",
          message: "The invitation details could not be read.",
          hint: "Ask a workspace admin to send a fresh invite.",
        };
        throw failure;
      }
      const info = parsed.data;
      return {
        id: info.id,
        email: info.email ?? null,
        role: info.role ?? null,
        status: info.status ?? null,
        organizationName: info.organizationName ?? null,
        organizationSlug: info.organizationSlug ?? null,
        inviterEmail: info.inviterEmail ?? null,
        expiresAt: info.expiresAt ?? null,
      } satisfies InvitationInfo;
    },
  });

  const acceptMutation = useMutation<void, AuthFormError, void>({
    mutationFn: async () => {
      const { error } = await authClient.organization.acceptInvitation({
        invitationId: token,
      });
      if (error !== null && error !== undefined) {
        throw toAuthFormError(error);
      }
    },
    onSuccess: () => {
      // §20 #1: the member now sees the same workspace — better-auth already
      // activated it on the session, so /dashboard opens into it.
      router.replace(POST_AUTH_PATH);
    },
  });

  return (
    <div className="w-full max-w-md space-y-5 rounded-lg border border-border bg-surface p-6 shadow-sm">
      <a href="/" className="block font-mono text-lg font-semibold tracking-tight">
        {SITE_NAME}
      </a>

      {session.isPending ? (
        <div className="space-y-3" aria-busy="true">
          <div className="h-6 w-48 rounded-md bg-surface-muted" />
          <div className="h-4 w-full rounded-md bg-surface-muted" />
          <div className="h-9 w-40 rounded-md bg-surface-muted" />
        </div>
      ) : session.data === null ? (
        <div className="space-y-4">
          <h1 className="text-lg font-semibold">You&apos;ve been invited</h1>
          <p className="text-sm text-muted-foreground">
            Sign in with the email that received this invite to see the details
            and join the workspace.
          </p>
          <div className="flex flex-col gap-2">
            <Link
              href={`/sign-in?next=${encodeURIComponent(invitePath)}`}
              className="rounded-md bg-accent px-4 py-2 text-center text-sm font-semibold text-accent-foreground transition hover:opacity-90"
            >
              Sign in to accept
            </Link>
            <Link
              href={`/sign-up?next=${encodeURIComponent(invitePath)}`}
              className="rounded-md border border-border bg-surface px-4 py-2 text-center text-sm font-semibold transition hover:bg-surface-muted"
            >
              Create an account
            </Link>
          </div>
        </div>
      ) : invitation.isPending ? (
        <div className="space-y-3" aria-busy="true">
          <div className="h-6 w-48 rounded-md bg-surface-muted" />
          <div className="h-4 w-full rounded-md bg-surface-muted" />
          <div className="h-9 w-40 rounded-md bg-surface-muted" />
        </div>
      ) : invitation.isError ? (
        <div className="space-y-4">
          <h1 className="text-lg font-semibold">This invite can&apos;t be opened</h1>
          <AuthError error={invitation.error} />
          <p className="text-xs text-muted-foreground">
            Invites expire and can only be opened by the email that received
            them. Ask a workspace admin to send a fresh one.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                void invitation.refetch();
              }}
              className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition hover:opacity-90"
            >
              Try again
            </button>
            <Link
              href={POST_AUTH_PATH}
              className="rounded-md border border-border bg-surface px-4 py-2 text-sm font-semibold transition hover:bg-surface-muted"
            >
              Go to dashboard
            </Link>
          </div>
        </div>
      ) : invitation.data === null || invitation.data === undefined ? (
        <p className="text-sm text-muted-foreground">Loading invitation…</p>
      ) : (
        <div className="space-y-4">
          <h1 className="text-lg font-semibold">
            Join {invitation.data.organizationName ?? "the workspace"}
          </h1>
          <p className="text-sm text-muted-foreground">
            You&apos;ve been invited to join{" "}
            <span className="font-medium text-foreground">
              {invitation.data.organizationName ?? "a workspace"}
            </span>
            {invitation.data.inviterEmail !== null
              ? ` by ${invitation.data.inviterEmail}`
              : ""}{" "}
            as{" "}
            <span className="inline-flex items-center rounded-full border border-border bg-surface-muted px-2 py-0.5 font-medium text-foreground">
              {displayRole(invitation.data.role)}
            </span>
            .
          </p>
          <p className="text-xs text-muted-foreground">
            {describeRole(invitation.data.role)}
          </p>
          {acceptMutation.error === null ? null : (
            <AuthError error={acceptMutation.error} />
          )}
          {acceptMutation.isSuccess ? (
            <p className="rounded-md border border-border bg-surface-muted p-3 text-sm text-muted-foreground">
              You&apos;re in — opening your workspace…
            </p>
          ) : (
            <button
              type="button"
              disabled={acceptMutation.isPending}
              onClick={() => {
                void acceptMutation.mutate();
              }}
              className="w-full rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {acceptMutation.isPending ? "Joining…" : "Accept invite"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
