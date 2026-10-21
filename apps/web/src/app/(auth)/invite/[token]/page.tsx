import { InviteCard } from "@/components/auth/invite-card";
import { pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "Workspace invitation",
  description: "Accept or decline a Studio workspace invitation.",
  path: "/invite",
});

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <InviteCard token={token} />;
}
