// app/(app)/dashboard/page.tsx — dashboard index (W8-A).
//
// Route note: the task brief spelled the path "(app)/(dashboard)/page.tsx",
// but route groups add no URL segment — that file would resolve to "/", which
// is already the §16.2 marketing home (src/app/page.tsx, W1-K) and a hard
// Next "duplicate page" conflict. The dashboard index therefore lives at the
// /dashboard segment, mirroring vendor/next-saas-stripe-starter's
// app/(app)/dashboard/page.tsx.

import type { Metadata } from "next";
import { DashboardView } from "./dashboard-view";

export const metadata: Metadata = {
  title: "Dashboard",
};

export default function DashboardPage() {
  return <DashboardView />;
}
