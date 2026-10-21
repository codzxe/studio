// Invite acceptance page (W8-B; §20 #1 — sign-up → workspace → invite flow).
//
// /invite/:token where `token` is the Better Auth organization invitation id
// carried by the invite email's link. This server wrapper awaits Next 15's
// params promise and hands the token to the client card (the card needs the
// browser session to fetch + accept). The (app) group has no layout yet, so
// the page carries its own centered chrome; when the app shell lands it can
// absorb the wrapper.

import type { Metadata } from "next";
import { AcceptInviteCard } from "./accept-invite-card";

export const metadata: Metadata = {
  title: "Workspace invite",
};

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-muted px-6 py-12">
      <AcceptInviteCard token={token} />
    </main>
  );
}
