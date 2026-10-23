import { ShellLayout } from "@/components/shell/shell-layout";

/**
 * The SaaS shell layout (W2-01, §8.4) for the `/w` surface.
 *
 * A URL-INVISIBLE route group: pages under `(shell)` keep their exact URLs
 * (`/w`, `/w/billing`, `/w/projects`, `/w/settings/*`) but gain the shell
 * (rail + top bar + ⌘K palette + offline banner + toasts). The editor route
 * `/w/[slug]/editor` lives OUTSIDE this group and stays full-bleed (§8.7).
 *
 * All resolution logic lives in `components/shell/shell-layout.tsx` (RSC:
 * `/v1/me` + `/v1/billing/state`; 401 → `/sign-in?next=/w`; no membership →
 * `/onboarding`).
 */
export default ShellLayout;
