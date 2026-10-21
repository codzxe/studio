"use client";

// Auth error box (W8-B) — renders the typed flat-envelope error from
// src/lib/auth.ts (`AuthFormError`): message first, `hint` beneath it when the
// gateway sends one (§13.3). role="alert" so screen readers announce it.

import type { AuthFormError } from "@/lib/auth";

export function AuthError({ error }: { readonly error: AuthFormError }) {
  return (
    <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm">
      <p className="font-medium text-red-700">{error.message}</p>
      {error.hint === undefined ? null : (
        <p className="mt-1 text-xs text-red-600">{error.hint}</p>
      )}
    </div>
  );
}

// TODO(ui tokens): red-* utilities mirror the W1-K error styling; swap for a
// destructive token when apps/web's globals.css grows one (@studio/ui ships
// --destructive; the web token set hasn't adopted it yet).
