"use client";

/**
 * NewProjectDialog (W2-03, §8.4) — the dashboard's primary action.
 *
 * Name → `POST /v1/projects` → navigate to the new project's hub
 * (`/w/[slug]/history`), where the editor opens from. One idempotency key
 * per attempt (law #4): the gateway replays a re-sent key instead of
 * creating a second project; a retry after a FAILED attempt uses a fresh
 * key. Typed failures (§7.3) surface inline — message + hint + request id,
 * never a toast (§8.2 error law) and never a stack (law #1).
 *
 * Boundary law (apps/web): `@studio/contracts` is `import type` ONLY — the
 * name bound is PROJECT_NAME_SCHEMA restated locally (1–120 chars).
 */

import { type CallOptions, isApiError } from "@studio/api-client";
import type { CreateProjectRequest, Project } from "@studio/contracts";
import {
  Button,
  Dialog,
  DialogActions,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
} from "@studio/ui";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";

/** PROJECT_NAME_SCHEMA (contracts routes/projects.ts), restated locally. */
const NAME_MAX_LENGTH = 120;

/** A bounded §7.3 failure surface (message + hint + request id, §14). */
export interface NewProjectError {
  readonly message: string;
  readonly hint?: string;
  readonly requestId?: string;
}

/** The `POST /v1/projects` seam — the api-client's `projects.create`. */
export type CreateProject = (body: CreateProjectRequest, options?: CallOptions) => Promise<Project>;

export interface NewProjectDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The create seam (the dashboard's port in production; a fake in tests). */
  readonly createProject: CreateProject;
}

/** Typed §7.3 failure → the bounded inline surface; anything else → generic. */
export function toNewProjectError(cause: unknown): NewProjectError {
  if (isApiError(cause)) {
    return { message: cause.message, hint: cause.hint, requestId: cause.requestId };
  }
  return { message: "The project could not be created.", hint: "Try again in a moment." };
}

export function NewProjectDialog({ open, onOpenChange, createProject }: NewProjectDialogProps) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<NewProjectError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Transient state resets when the dialog closes — a reopen starts clean.
  useEffect(() => {
    if (open) return;
    setName("");
    setNameError(null);
    setFormError(null);
    setSubmitting(false);
  }, [open]);

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (submitting) return;
    const trimmed = name.trim();
    const nextNameError =
      trimmed.length === 0
        ? "Name your project — it needs a name."
        : trimmed.length > NAME_MAX_LENGTH
          ? `Project names are at most ${NAME_MAX_LENGTH} characters.`
          : null;
    setNameError(nextNameError);
    setFormError(null);
    if (nextNameError !== null) return;

    setSubmitting(true);
    // One fresh idempotency key per attempt (law #4): a re-sent key replays
    // instead of double-creating; a retry after a failure gets a fresh one.
    createProject({ name: trimmed }, { idempotencyKey: crypto.randomUUID() })
      .then((project) => {
        onOpenChange(false);
        router.push(`/w/${project.slug}/history`);
      })
      .catch((cause: unknown) => {
        setSubmitting(false);
        setFormError(toNewProjectError(cause));
      });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="new-project-dialog">
        <DialogTitle>New project</DialogTitle>
        <DialogDescription>
          A project holds your compositions, versions and renders. You can rename it anytime.
        </DialogDescription>
        <form className="mt-4 flex flex-col gap-4" onSubmit={onSubmit} noValidate>
          <Input
            id="new-project-name"
            type="text"
            label="Project name"
            autoComplete="off"
            value={name}
            onChange={(event) => setName(event.target.value)}
            error={nameError}
            helperText="Visible to everyone in this workspace."
            required
            data-testid="new-project-name"
          />
          {formError !== null ? (
            <div role="alert" data-testid="new-project-error" className="flex flex-col gap-1">
              <p className="text-caption text-danger">{formError.message}</p>
              {formError.hint !== undefined ? (
                <p className="text-caption text-muted">{formError.hint}</p>
              ) : null}
              {formError.requestId !== undefined ? (
                <p className="text-caption text-muted">Request {formError.requestId}</p>
              ) : null}
            </div>
          ) : null}
          <DialogActions>
            <DialogClose asChild>
              <Button variant="secondary" data-testid="new-project-cancel">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" loading={submitting} data-testid="new-project-create">
              Create project
            </Button>
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}
