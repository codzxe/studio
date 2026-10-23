import { ShellLayout } from "@/components/shell/shell-layout";

/**
 * The SaaS shell layout (W2-01, §8.4) for the project hub surface —
 * `/w/[slug]/history` (W2-05 owns the page content; this group exists so the
 * hub mounts into the same shell as the rest of `/w` while the sibling
 * `editor` route stays full-bleed, §8.7 hard rule).
 *
 * Same RSC resolution as `w/(shell)/layout.tsx` (see
 * `components/shell/shell-layout.tsx`): the project itself is resolved by the
 * PAGE (slug scan across workspaces); the shell only needs the session,
 * memberships and the default workspace's billing state.
 */
export default ShellLayout;
