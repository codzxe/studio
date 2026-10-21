"use client";

import { authClient } from "@/lib/auth-client";
import { Brand } from "@studio/config";
import { Badge, Button, Spinner } from "@studio/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Invite acceptance (§8.2): reads the token, shows the workspace, inviter and
 * role from the gateway (organization.getInvitation), then accepts or
 * declines. Signed-out visitors get a sign-in link that round-trips back to
 * the invite via ?next=. All server errors surface inline — never toasts.
 */

/** Fields we render; the gateway response carries more (status, email, …). */
interface InviteInfo {
  organizationName?: string | null;
  inviterEmail?: string | null;
  role?: string | null;
  status?: string | null;
}

type Phase = "loading" | "needs-auth" | "invalid" | "ready";

export function InviteCard({ token }: { token: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("loading");
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [working, setWorking] = useState<"accept" | "decline" | null>(null);

  useEffect(() => {
    let cancelled = false;
    authClient.organization
      .getInvitation({ query: { id: token } })
      .then(({ data, error }) => {
        if (cancelled) {
          return;
        }
        if (error) {
          if (error.status === 401 || error.code === "UNAUTHORIZED") {
            setPhase("needs-auth");
          } else {
            setPhase("invalid");
          }
          return;
        }
        if (!data || data.status !== "pending") {
          setPhase("invalid");
          return;
        }
        setInvite(data);
        setPhase("ready");
      })
      .catch(() => {
        if (!cancelled) {
          setPhase("invalid");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function onAccept() {
    setWorking("accept");
    setActionError(null);
    const { error } = await authClient.organization.acceptInvitation({
      invitationId: token,
    });
    if (error) {
      setActionError(error.message ?? "Couldn't accept the invite. Try again in a moment.");
      setWorking(null);
      return;
    }
    router.push("/w");
    router.refresh();
  }

  async function onDecline() {
    setWorking("decline");
    setActionError(null);
    const { error } = await authClient.organization.rejectInvitation({
      invitationId: token,
    });
    if (error) {
      setActionError(error.message ?? "Couldn't decline the invite. Try again in a moment.");
      setWorking(null);
      return;
    }
    router.push("/");
  }

  const signInHref = `/sign-in?next=${encodeURIComponent(`/invite/${token}`)}`;

  return (
    <div className="flex flex-col gap-8" data-testid="invite-card">
      {phase === "loading" ? (
        <div className="flex flex-col items-center gap-4 py-16" data-testid="invite-loading">
          <Spinner size={24} label="Reading the invitation" />
          <p className="text-body-s text-muted">Reading the invitation…</p>
        </div>
      ) : null}

      {phase === "needs-auth" ? (
        <div className="flex flex-col gap-6">
          <h1 className="font-display text-display-m text-balance text-primary">
            Sign in to accept this invite.
          </h1>
          <p className="text-body-s leading-relaxed text-secondary">
            You&apos;ve been invited to a workspace. Sign in first and you&apos;ll come straight
            back here to accept.
          </p>
          <Link
            href={signInHref}
            className="self-start text-primary underline underline-offset-3 transition-colors duration-120 hover:text-signal"
          >
            Sign in
          </Link>
        </div>
      ) : null}

      {phase === "invalid" ? (
        <div className="flex flex-col gap-6">
          <h1 className="font-display text-display-m text-balance text-primary">
            This invitation doesn&apos;t work anymore.
          </h1>
          <p className="text-body-s leading-relaxed text-secondary">
            The link is invalid, expired, or already used. Ask a workspace admin to send a fresh
            one.
          </p>
          <Link
            href="/"
            className="self-start text-primary underline underline-offset-3 transition-colors duration-120 hover:text-signal"
          >
            Back to {Brand.productName}
          </Link>
        </div>
      ) : null}

      {phase === "ready" && invite ? (
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-3">
            <p className="text-label uppercase tracking-[0.06em] text-muted">Invitation</p>
            <h1 className="font-display text-display-m text-balance text-primary">
              Join {invite.organizationName ?? "the workspace"}.
            </h1>
          </div>

          <dl className="flex flex-col gap-3 rounded-md border border-border bg-panel p-6 text-body-s">
            <div className="flex items-baseline justify-between gap-6">
              <dt className="text-muted">Workspace</dt>
              <dd className="text-primary">{invite.organizationName ?? "—"}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-6">
              <dt className="text-muted">Invited by</dt>
              <dd className="text-primary">{invite.inviterEmail ?? "—"}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-6">
              <dt className="text-muted">Role</dt>
              <dd>
                <Badge variant="ice">{invite.role ?? "member"}</Badge>
              </dd>
            </div>
          </dl>

          {actionError ? (
            <p role="alert" className="text-caption text-danger">
              {actionError}
            </p>
          ) : null}

          <div className="flex items-center gap-3">
            <Button
              variant="primary"
              size="lg"
              onClick={() => onAccept()}
              loading={working === "accept"}
            >
              Accept invite
            </Button>
            <Button
              variant="ghost"
              size="lg"
              onClick={() => onDecline()}
              loading={working === "decline"}
            >
              Decline
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
