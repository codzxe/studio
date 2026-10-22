"use client";

// Request access (BUILD_PLAN §M7 task 5): an anonymous reviewer — including
// one locked out by the password gate, which is exactly who needs this — can
// ask the owning workspace for access. The endpoint is NOT password-gated
// (see the gateway route) and records the request as a `share.request_access`
// audit row the workspace reads in its activity feed (v1 notification).

import type { RequestAccessRequest } from "@studio/contracts";
import { Button, Input, Textarea } from "@studio/ui";
import { useState } from "react";

import { loadGuestIdentity } from "./share-format";
import type { SharePort } from "./share-port";
import { type ShareFailure, describeShareFailure } from "./share-port";

/** Contracts bound (mirrored; the gateway re-validates): 320 email, 2000 note. */
const REQUEST_ACCESS_EMAIL_MAX = 320;
const REQUEST_ACCESS_MESSAGE_MAX = 2000;

export interface ShareRequestAccessProps {
  readonly port: SharePort;
  readonly token: string;
  /** Compact layout inside the password gate; full inside the review body. */
  readonly variant?: "compact" | "full";
}

export function ShareRequestAccess({ port, token, variant = "full" }: ShareRequestAccessProps) {
  const [open, setOpen] = useState(variant === "full");
  // Lazy init runs during SSR too — `window` only exists in the browser.
  const [email, setEmail] = useState(() =>
    typeof window === "undefined" ? "" : loadGuestIdentity(window.sessionStorage).email,
  );
  const [message, setMessage] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; message?: string }>({});
  const [failure, setFailure] = useState<ShareFailure | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFailure(null);
    setSent(false);
    const trimmedEmail = email.trim();
    const trimmedMessage = message.trim();
    const errors: { email?: string; message?: string } = {};
    if (trimmedEmail.length === 0) errors.email = "Add the email the workspace should reach.";
    else if (
      trimmedEmail.length > REQUEST_ACCESS_EMAIL_MAX ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)
    ) {
      errors.email = "That email doesn't look right.";
    }
    if (trimmedMessage.length > REQUEST_ACCESS_MESSAGE_MAX) {
      errors.message = `Keep the note under ${REQUEST_ACCESS_MESSAGE_MAX} characters.`;
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const body: RequestAccessRequest =
      trimmedMessage.length > 0
        ? { email: trimmedEmail, message: trimmedMessage }
        : { email: trimmedEmail };
    setSending(true);
    try {
      await port.requestAccess(token, body);
      setSent(true);
      setMessage("");
    } catch (error) {
      setFailure(describeShareFailure(error));
    } finally {
      setSending(false);
    }
  }

  if (!open) {
    return (
      <div className="flex flex-col gap-2" data-testid="share-request-access-collapsed">
        <p className="text-body-s text-secondary">Locked out, or need edit rights?</p>
        <button
          type="button"
          data-testid="share-request-access-toggle"
          onClick={() => setOpen(true)}
          className="self-start text-body-s text-primary underline underline-offset-3 transition-colors duration-120 hover:text-signal"
        >
          Request access from the workspace
        </button>
      </div>
    );
  }

  return (
    <form
      data-testid="share-request-access"
      noValidate
      onSubmit={(event) => void onSubmit(event)}
      className="flex flex-col gap-4 rounded-md border border-border bg-panel p-4 md:p-6"
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-title-m text-primary">Request access</h3>
        <p className="text-body-s text-secondary">
          The workspace will see your request in its activity feed.
        </p>
      </div>
      <Input
        id="share-request-access-email"
        data-testid="share-request-access-email"
        label="Email"
        type="email"
        required
        maxLength={REQUEST_ACCESS_EMAIL_MAX}
        value={email}
        error={fieldErrors.email ?? null}
        onChange={(event) => setEmail(event.currentTarget.value)}
        autoComplete="email"
      />
      <Textarea
        id="share-request-access-message"
        data-testid="share-request-access-message"
        label="Note (optional)"
        rows={3}
        maxLength={REQUEST_ACCESS_MESSAGE_MAX}
        value={message}
        error={fieldErrors.message ?? null}
        onChange={(event) => setMessage(event.currentTarget.value)}
        placeholder="Who you are and what you need."
      />
      {failure !== null ? (
        <p
          role="alert"
          data-testid="share-request-access-error"
          className="text-caption text-danger"
        >
          {failure.message}
        </p>
      ) : null}
      {sent && failure === null ? (
        <p data-testid="share-request-access-ok" className="text-caption text-success">
          Request sent. The workspace will see it in its activity feed.
        </p>
      ) : null}
      <Button
        type="submit"
        variant="secondary"
        data-testid="share-request-access-submit"
        loading={sending}
        className="self-start"
      >
        Send request
      </Button>
    </form>
  );
}
