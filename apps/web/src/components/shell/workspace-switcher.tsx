"use client";

// components/shell/workspace-switcher — sidebar workspace dropdown (W8-A).
//
// Lists GET /v1/workspaces memberships; the checked radio marks the active
// workspace. Switching is client-only state today — the gateway derives the
// active organization from the session, not from the client (TODO(W8-B);
// see the header of src/hooks/use-session.tsx). Keyboard + ARIA wiring
// lives in ./use-menu.

import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { useId } from "react";
import { useSession } from "@/hooks/use-session";
import { useMenu } from "./use-menu";

const TRIGGER_CLASS =
  "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const MENU_PANEL_CLASS =
  "absolute left-0 top-full z-50 mt-1 w-56 rounded-md border border-border bg-surface p-1 shadow-md";

const ITEM_CLASS =
  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const MENU_HINT_CLASS = "px-2 py-1.5 text-sm text-muted-foreground";

export interface WorkspaceSwitcherProps {
  /** Closes the mobile nav drawer after a workspace is picked. */
  readonly onSelect?: () => void;
}

export function WorkspaceSwitcher({ onSelect }: WorkspaceSwitcherProps) {
  const { workspaces, workspacesState, activeWorkspace, setActiveWorkspaceId } = useSession();
  const menu = useMenu({ onClose: onSelect });
  const triggerId = useId();

  const triggerLabel =
    workspacesState.status === "loading"
      ? "Workspaces…"
      : workspacesState.status === "error"
        ? "Workspaces unavailable"
        : activeWorkspace?.name ?? "No workspace";

  return (
    <div className="relative">
      <button
        ref={menu.triggerRef}
        id={triggerId}
        type="button"
        {...menu.triggerProps}
        className={TRIGGER_CLASS}
      >
        <span
          aria-hidden="true"
          className="grid size-6 shrink-0 place-items-center rounded-md bg-surface-muted text-xs font-semibold text-foreground"
        >
          {triggerLabel.charAt(0).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{triggerLabel}</span>
        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>
      {menu.open ? (
        <div
          ref={menu.menuRef}
          {...menu.menuProps}
          aria-labelledby={triggerId}
          className={MENU_PANEL_CLASS}
        >
          {workspacesState.status === "loading" ? (
            <p role="status" className={MENU_HINT_CLASS}>
              Loading workspaces…
            </p>
          ) : workspacesState.status === "error" ? (
            <p role="status" className={MENU_HINT_CLASS}>
              Workspaces unavailable — {workspacesState.message ?? "please retry later."}
            </p>
          ) : workspaces.length === 0 ? (
            <p className={MENU_HINT_CLASS}>No workspaces yet.</p>
          ) : (
            workspaces.map((workspace, index) => {
              const selected = workspace.id === activeWorkspace?.id;
              return (
                <button
                  key={workspace.id}
                  ref={(element) => {
                    menu.registerItem(index, element);
                  }}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  onClick={() => {
                    setActiveWorkspaceId(workspace.id);
                    menu.closeMenu();
                  }}
                  className={ITEM_CLASS}
                >
                  <Check
                    className={`size-4 shrink-0 ${selected ? "text-foreground" : "invisible"}`}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                  <span
                    className="shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-[11px] text-muted-foreground capitalize"
                  >
                    {workspace.role}
                  </span>
                </button>
              );
            })
          )}
          <div className="my-1 border-t border-border" />
          {/* TODO(settings wave): create-workspace dialog (POST /v1/workspaces,
              §13.1) once the settings pages own the flow. */}
          <button
            ref={(element) => {
              menu.registerItem(workspaces.length, element);
            }}
            type="button"
            role="menuitem"
            disabled
            title="Workspace creation lands with the settings wave."
            className="flex w-full cursor-not-allowed items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-muted-foreground"
          >
            <Plus className="size-4 shrink-0" aria-hidden="true" />
            New workspace
          </button>
        </div>
      ) : null}
    </div>
  );
}
