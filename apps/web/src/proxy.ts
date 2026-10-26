import { type NextRequest, NextResponse } from "next/server";

/**
 * Edge proxy — Next 16's renamed middleware convention (`proxy.ts`; the old
 * `middleware.ts` name prints a deprecation warning on 16.x).
 *
 * Deliberately MINIMAL and cookie-presence-only:
 * - No session validation here — that is the gateway's job (it owns the
 *   better-auth server and validates every request) and this file must
 *   never become an auth oracle. A missing cookie bounces to /sign-in with
 *   ?next= so the round-trip preserves the destination.
 * - x-pathname is stamped for request-scoped logging/debugging.
 *
 * The session cookie name is better-auth's default (see
 * src/lib/auth-client.ts SESSION_COOKIE_NAME) — but better-auth PREFIXES it
 * with `__Secure-` whenever the auth origin is HTTPS (its secure-cookie
 * default). Local dev over http sets `better-auth.session_token`; production
 * (motiongra.vercel.app, HTTPS) sets `__Secure-better-auth.session_token`.
 * A presence-only check that names JUST the bare form redirects every
 * authenticated production visit back to /sign-in — the sign-in loop the
 * round-5 fix closed. Both names are accepted; nothing else changes.
 */
const SESSION_COOKIE_NAMES = [
  "better-auth.session_token",
  "__Secure-better-auth.session_token",
] as const;

export default function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (!SESSION_COOKIE_NAMES.some((name) => request.cookies.has(name))) {
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    url.search = `next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }

  const headers = new Headers(request.headers);
  headers.set("x-pathname", pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/w/:path*"],
};
