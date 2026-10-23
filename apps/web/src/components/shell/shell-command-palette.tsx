"use client";

/**
 * ShellCommandPalette (W2-01, §7.10 + D-5) — the ⌘K palette for the SaaS
 * shell. The shell mounts it OUTSIDE the editor route (the `(shell)` route
 * group never contains `/w/[slug]/editor`), so a document-level ⌘K listener
 * is safe; inside the editor, ⌘K stays the editor's own shortcut (ECUX §4.2).
 *
 * Groups in the §7.10 fixed order (the kit's CommandPalette enforces it):
 * - **Projects** — `projects.list` (limit 10) on OPEN; picking one navigates
 *   to its hub `/w/<slug>/history`. A failed/empty read degrades to an empty
 *   group (never a spinner, never a crash).
 * - **Actions** — the shell-level verbs: New project (the dashboard's dialog
 *   owns creation — the palette navigates to `/w` where it lives) and Buy
 *   credits (`/w/billing`).
 * - **Navigation** — the four §8.4 rail destinations.
 * - **Help** — the real marketing/status routes (status, changelog,
 *   licences); nothing speculative.
 *
 * Enter runs, Esc closes, ↑/↓/Home/End move — all inside the kit palette.
 */

import { type CommandItem, CommandPalette } from "@studio/ui";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import type { ShellPort } from "./top-bar";

/** Palette project rows: display name + hub destination only. */
interface PaletteProject {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

/** Cap of the Projects group (§7.10 — a palette, not a browser). */
const PROJECTS_LIMIT = 10;

export interface ShellCommandPaletteProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The active workspace's port (projects.list fires on open). */
  readonly port: ShellPort;
}

export function ShellCommandPalette({ open, onOpenChange, port }: ShellCommandPaletteProps) {
  const router = useRouter();
  const [projects, setProjects] = useState<readonly PaletteProject[]>([]);

  // Projects load on open; the reset on close keeps the next open honest.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    port.projects
      .list({ limit: PROJECTS_LIMIT })
      .then((page) => {
        if (cancelled) return;
        setProjects(
          page.items.map((project) => ({
            id: project.id,
            name: project.name,
            slug: project.slug,
          })),
        );
      })
      .catch(() => {
        // Failed read → empty group (search still works over the others).
        if (!cancelled) setProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, port]);

  const items = useMemo<CommandItem[]>(() => {
    const projectItems: CommandItem[] = projects.map((project) => ({
      id: `project-${project.id}`,
      group: "projects",
      label: project.name,
      onSelect: () => router.push(`/w/${project.slug}/history`),
    }));

    const actionItems: readonly CommandItem[] = [
      {
        id: "action-new-project",
        group: "actions",
        label: "New project",
        shortcut: "⌘N",
        onSelect: () => router.push("/w"),
      },
      {
        id: "action-buy-credits",
        group: "actions",
        label: "Buy credits",
        onSelect: () => router.push("/w/billing"),
      },
    ];

    const navigationItems: readonly CommandItem[] = [
      {
        id: "nav-dashboard",
        group: "navigation",
        label: "Go to dashboard",
        onSelect: () => router.push("/w"),
      },
      {
        id: "nav-projects",
        group: "navigation",
        label: "Go to projects",
        onSelect: () => router.push("/w/projects"),
      },
      {
        id: "nav-billing",
        group: "navigation",
        label: "Go to billing",
        onSelect: () => router.push("/w/billing"),
      },
      {
        id: "nav-settings",
        group: "navigation",
        label: "Go to settings",
        onSelect: () => router.push("/w/settings"),
      },
    ];

    const helpItems: readonly CommandItem[] = [
      {
        id: "help-status",
        group: "help",
        label: "Service status",
        onSelect: () => router.push("/status"),
      },
      {
        id: "help-changelog",
        group: "help",
        label: "Changelog",
        onSelect: () => router.push("/changelog"),
      },
      {
        id: "help-licences",
        group: "help",
        label: "Licences",
        onSelect: () => router.push("/legal/licences"),
      },
    ];

    return [...projectItems, ...actionItems, ...navigationItems, ...helpItems];
  }, [projects, router]);

  return (
    <CommandPalette
      open={open}
      onOpenChange={onOpenChange}
      items={items}
      placeholder="Search projects, actions…"
      emptyMessage="No results."
    />
  );
}
