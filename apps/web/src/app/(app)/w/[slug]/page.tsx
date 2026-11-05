import { notFound, redirect } from "next/navigation";

import { ChatFirstStudio } from "@/components/chat-studio/chat-first-studio";
import { loadEditorProject } from "@/components/editor-host/resolve-project";
import type { EditorHostPayload } from "@/components/editor-host/types";
import { pageMetadata } from "@/lib/seo";

/**
 * The CHAT-FIRST studio route: `/w/:projectSlug` (round 16 — the product ask:
 * "give both options, engine and chat, where MAIN is chat and no engine is
 * visible"). This is now the project's landing surface:
 *
 * - Chat (default): a full-page ChatGPT-style conversation with the agent.
 *   The editor mounts live but hidden underneath (the tool bridge needs it);
 *   no engine chrome is visible.
 * - Engine: the classic full editor (`EditorHost`, unchanged) — one click on
 *   the mode bar, no re-boot (the session stays mounted).
 *
 * Project resolution is the editor route's exact behavior (shared
 * `loadEditorProject`): 401 → sign-in round-trip, cross-tenant/missing →
 * 404, wire drift → the Next error boundary.
 */

interface StudioPageProps {
  readonly params: Promise<{ readonly slug: string }>;
}

const loadStudioProject = (slug: string): Promise<EditorHostPayload> =>
  loadEditorProject(slug, `/w/${slug}`);

export async function generateMetadata({ params }: StudioPageProps) {
  const { slug } = await params;
  const name = (await loadStudioProject(slug)).manifest.project.name;
  return pageMetadata({
    title: `${name} — chat`,
    description: `Make “${name}” by chatting with the Studio agent. Open the Engine whenever you want hands-on.`,
    path: `/w/${slug}`,
  });
}

export default async function StudioPage({ params }: StudioPageProps) {
  const { slug } = await params;
  const payload = await loadStudioProject(slug);

  return <ChatFirstStudio payload={payload} />;
}
