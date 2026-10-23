"use client";

/**
 * WorkspaceStep — onboarding step 1 (UI_DESIGN_SYSTEM §8.3; manifest W2-02).
 *
 * Workspace name + URL slug. The slug is derived LIVE from the name by the
 * previously-orphaned `slug.ts` slugify (W2-02 finally wires it): every name
 * keystroke re-derives the slug until the user edits the slug field directly
 * — the manual edit then sticks. Submit creates the workspace
 * (`POST /v1/workspaces`); the typed 409 CONFLICT ("that slug is taken")
 * lands inline on the slug field, never as a toast (§8.2 error law).
 *
 * Boundary law (apps/web): `@studio/contracts` is `import type` ONLY, so the
 * slug grammar is restated locally from WORKSPACE_SLUG_SCHEMA.
 */

import { type CallOptions, isApiError } from "@studio/api-client";
import type { CreateWorkspaceRequest, Workspace } from "@studio/contracts";
import { Button, Input } from "@studio/ui";
import { type FormEvent, useState } from "react";

import { slugify } from "./slug";

/**
 * WORKSPACE_SLUG_SCHEMA (packages/contracts routes/workspaces.ts), restated
 * locally: lowercase alnum + inner hyphens, 1-64 chars, alnum at both ends.
 */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** A bounded §7.3 failure surface (message + hint + request id, §14). */
interface StepError {
  readonly message: string;
  readonly hint?: string;
  readonly requestId?: string;
}

export interface WorkspaceStepProps {
  /** POST /v1/workspaces (injected — the flow's port or a test fake). */
  readonly createWorkspace: (
    body: CreateWorkspaceRequest,
    options?: CallOptions,
  ) => Promise<Workspace>;
  /** Step 1 success: the created workspace, handed up to the flow. */
  readonly onCreated: (workspace: Workspace) => void;
}

export function WorkspaceStep({ createWorkspace, onCreated }: WorkspaceStepProps) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [slugError, setSlugError] = useState<string | null>(null);
  const [formError, setFormError] = useState<StepError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function onNameChange(value: string) {
    setName(value);
    // Live derivation until the slug field is touched (slug.ts contract).
    if (!slugEdited) setSlug(slugify(value));
  }

  function onSlugChange(value: string) {
    setSlugEdited(true);
    setSlug(value);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    const nextNameError = trimmedName.length >= 1 ? null : "Name your workspace — it needs a name.";
    const nextSlugError = SLUG_PATTERN.test(slug)
      ? null
      : "Lowercase letters, numbers and hyphens — starting and ending with a letter or number.";
    setNameError(nextNameError);
    setSlugError(nextSlugError);
    setFormError(null);
    if (nextNameError !== null || nextSlugError !== null) return;

    setSubmitting(true);
    createWorkspace({ name: trimmedName, slug })
      .then((workspace) => {
        onCreated(workspace);
      })
      .catch((error: unknown) => {
        setSubmitting(false);
        if (isApiError(error)) {
          // Typed conflict arm (§8.3): the slug is taken — inline, on the field.
          if (error.status === 409 || error.code === "CONFLICT") {
            setSlugError("That slug is taken. Pick a different one.");
            return;
          }
          setFormError({
            message: error.message,
            hint: error.hint,
            requestId: error.requestId,
          });
          return;
        }
        setFormError({
          message: "Couldn't create the workspace. Try again in a moment.",
          hint: "Check your connection, then retry.",
        });
      });
  }

  return (
    <form className="flex flex-col gap-6" onSubmit={onSubmit} noValidate>
      <div className="flex flex-col gap-2">
        <h2 className="text-body-l font-medium text-primary">Name your workspace.</h2>
        <p className="text-body-s text-secondary">
          This is where your projects and compositions live. You can rename it later in settings.
        </p>
      </div>

      <Input
        id="onboarding-name"
        type="text"
        label="Workspace name"
        inputSize="lg"
        autoComplete="off"
        value={name}
        onChange={(event) => onNameChange(event.target.value)}
        error={nameError}
        required
      />

      <div className="flex flex-col gap-2">
        <Input
          id="onboarding-slug"
          type="text"
          label="Slug"
          inputSize="lg"
          autoComplete="off"
          value={slug}
          onChange={(event) => onSlugChange(event.target.value)}
          error={slugError}
          helperText={
            slugEdited
              ? "You set this slug by hand."
              : "Derived from the name — edit it if you like."
          }
          required
        />
        <p
          className="text-caption text-muted"
          data-testid="onboarding-slug-preview"
          aria-live="polite"
        >
          {slug === "" ? "Your work will live at /w/…" : `Your work will live at /w/${slug}`}
        </p>
      </div>

      {formError ? (
        <div role="alert" data-testid="onboarding-workspace-error" className="flex flex-col gap-1">
          <p className="text-caption text-danger">{formError.message}</p>
          {formError.hint ? <p className="text-caption text-muted">{formError.hint}</p> : null}
          {formError.requestId ? (
            <p className="text-caption text-muted">Request {formError.requestId}</p>
          ) : null}
        </div>
      ) : null}

      <Button type="submit" size="lg" className="self-start" loading={submitting}>
        Continue
      </Button>
    </form>
  );
}
