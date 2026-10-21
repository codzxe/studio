// app/(app)/settings — workspace settings (W8-L).
//
// Server component: metadata only. The tabbed client shell
// (components/settings/settings-view.tsx) owns the five sections — General
// (rename), Brand (token editor), Members (roster + invites, §13.1),
// API keys (§15.2 show-once) and Danger zone (owner delete / leave) — all
// through the typed gateway client + Better Auth seams in
// components/settings/use-settings.ts (spec §13, §15.2).

import type { Metadata } from "next";
import { SettingsView } from "@/components/settings/settings-view";

export const metadata: Metadata = {
  title: "Settings",
};

export default function SettingsPage() {
  return <SettingsView />;
}
