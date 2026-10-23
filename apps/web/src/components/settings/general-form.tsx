"use client";

/**
 * GeneralForm — the `/w/settings` General card (W2-06, §8.9).
 *
 * Workspace name + slug display and edit through `PATCH /v1/workspaces/:id`
 * (`workspaces.patch` via `@studio/api-client`, same-origin with the
 * workspace header — the BillingPort pattern). The typed 409 CONFLICT
 * ("that slug is taken", routes/workspaces.ts:108) lands inline on the slug
 * field; every other §7.3 failure surfaces as the bounded
 * message/hint/request-id strip (§14).
 *
 * HONESTY (manifest W2-06): workspace logo and default project visibility
 * are v2 — this page renders NO fake fields for them, just the note.
 *
 * Boundary law (apps/web): `@studio/contracts` is `import type` ONLY, so the
 * slug grammar is restated locally from WORKSPACE_SLUG_SCHEMA.
 */

import { type ApiClient, type CallOptions, createApiClient, isApiError } from "@studio/api-client";
import type { PatchWorkspaceRequest, Workspace } from "@studio/contracts";
import { Button, Card, CardDescription, CardHeader, CardTitle, Input } from "@studio/ui";
import { type FormEvent, useState } from "react";

/**
 * WORKSPACE_SLUG_SCHEMA (packages/contracts routes/workspaces.ts), restated
 * locally: lowercase alnum + inner hyphens, 1-64 chars, alnum at both ends.
 */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

// ---------------------------------------------------------------------------
// The api seam — a narrow port the real ApiClient satisfies structurally
// ---------------------------------------------------------------------------

/** The workspace surface `@studio/api-client` exposes for this page. */
export interface GeneralPort {
  /** PATCH /v1/workspaces/:id — rename and/or re-slug (admin+ server-side). */
  readonly patchWorkspace: (
    body: PatchWorkspaceRequest,
    options?: CallOptions,
  ) => Promise<Workspace>;
}

/**
 * Compile-time pin (and tiny adapter): the production `ApiClient["workspaces"]`
 * satisfies {@link GeneralPort} — the page never hand-rolls a call.
 */
export function asGeneralPort(client: ApiClient, workspaceId: string): GeneralPort {
  return {
    patchWorkspace: (body, options) => client.workspaces.patch(workspaceId, body, options),
  };
}

/** Same-origin API root (Caddy fronts `/v1` in production — README §Env). */
const API_BASE_URL = "/v1";

/** Builds the production port for one workspace page load. */
function createDefaultGeneralPort(workspaceId: string): GeneralPort {
  return asGeneralPort(
    createApiClient({ baseUrl: API_BASE_URL, headers: { "x-workspace-id": workspaceId } }),
    workspaceId,
  );
}

// ---------------------------------------------------------------------------
// Bounded §7.3 failure surface (§14: message + hint + request id)
// ---------------------------------------------------------------------------

interface GeneralError {
  readonly message: string;
  readonly hint?: string;
  readonly requestId?: string;
}

function toGeneralError(error: unknown): GeneralError {
  if (isApiError(error)) {
    return { message: error.message, hint: error.hint, requestId: error.requestId };
  }
  return { message: "Something went wrong on our side.", hint: "Try again in a moment." };
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

export interface GeneralFormProps {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly workspaceSlug: string;
  /** owner/admin (`manageWorkspace`) — others read the fields, disabled. */
  readonly canManage: boolean;
  /** Injectable port (tests). Production leaves it undefined. */
  readonly api?: GeneralPort;
}

export function GeneralForm({
  workspaceId,
  workspaceName,
  workspaceSlug,
  canManage,
  api,
}: GeneralFormProps) {
  const port = api ?? createDefaultGeneralPort(workspaceId);
  const [name, setName] = useState(workspaceName);
  const [slug, setSlug] = useState(workspaceSlug);
  const [nameError, setNameError] = useState<string | null>(null);
  const [slugError, setSlugError] = useState<string | null>(null);
  const [formError, setFormError] = useState<GeneralError | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const dirty = name !== workspaceName || slug !== workspaceSlug;

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmedName = name.trim();
    const nextNameError = trimmedName.length >= 1 ? null : "Name your workspace — it needs a name.";
    const nextSlugError = SLUG_PATTERN.test(slug)
      ? null
      : "Lowercase letters, numbers and hyphens — starting and ending with a letter or number.";
    setNameError(nextNameError);
    setSlugError(nextSlugError);
    setFormError(null);
    setSaved(false);
    if (nextNameError !== null || nextSlugError !== null) return;

    // PATCH requires at least one field (contracts PATCH_WORKSPACE_SCHEMA) —
    // only the changed ones ride (idempotent no-ops stay no-ops).
    const body: PatchWorkspaceRequest = {};
    if (trimmedName !== workspaceName) body.name = trimmedName;
    if (slug !== workspaceSlug) body.slug = slug;

    setSaving(true);
    port
      .patchWorkspace(body)
      .then(() => {
        setSaving(false);
        setSaved(true);
        setName(trimmedName);
      })
      .catch((error: unknown) => {
        setSaving(false);
        if (isApiError(error)) {
          // Typed conflict arm: the slug is taken — inline, on the field.
          if (error.status === 409 || error.code === "CONFLICT") {
            setSlugError("That slug is taken. Pick a different one.");
            return;
          }
          setFormError(toGeneralError(error));
          return;
        }
        setFormError(toGeneralError(error));
      });
  }

  return (
    <section data-testid="general-form" className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-title-l font-medium text-primary">General</h1>
        <p className="text-body-s text-muted">
          The basics of this workspace — its name and its slug.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Workspace</CardTitle>
          <CardDescription>
            {canManage
              ? "Admins of this workspace can change the name and the slug."
              : "Only workspace admins can change these. Ask one if something needs updating."}
          </CardDescription>
        </CardHeader>
        <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
          <Input
            id="general-name"
            type="text"
            label="Name"
            value={name}
            autoComplete="off"
            disabled={!canManage || saving}
            onChange={(event) => {
              setName(event.target.value);
              setSaved(false);
            }}
            error={nameError}
            required
          />
          <Input
            id="general-slug"
            type="text"
            label="Slug"
            value={slug}
            autoComplete="off"
            disabled={!canManage || saving}
            onChange={(event) => {
              setSlug(event.target.value);
              setSaved(false);
            }}
            error={slugError}
            helperText="Lowercase letters, numbers and hyphens. Used to switch between your workspaces."
            required
          />
          {formError ? (
            <div role="alert" data-testid="general-error" className="flex flex-col gap-1">
              <p className="text-caption text-danger">{formError.message}</p>
              {formError.hint ? <p className="text-caption text-muted">{formError.hint}</p> : null}
              {formError.requestId ? (
                <p className="text-caption text-muted">Request {formError.requestId}</p>
              ) : null}
            </div>
          ) : null}
          {saved ? (
            <p data-testid="general-saved" className="text-caption text-success">
              Saved.
            </p>
          ) : null}
          {canManage ? (
            <Button
              type="submit"
              size="sm"
              className="self-start"
              loading={saving}
              disabled={!dirty && !saving}
              data-testid="general-save"
            >
              Save changes
            </Button>
          ) : null}
        </form>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Not configurable yet</CardTitle>
          <CardDescription>
            A workspace logo and a default project visibility setting arrive in v2 — there is
            nothing to set for them today, so nothing is shown here.
          </CardDescription>
        </CardHeader>
      </Card>
    </section>
  );
}
