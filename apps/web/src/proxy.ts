import { type NextRequest, NextResponse } from "next/server";

/**
 * Edge proxy — Next 16's renamed middleware convention (`proxy.ts`; the old
 * `middleware.ts` name prints a deprecation warning on 16.x).
 *
 * Deliberately MINIMAL and cookie-presence-only:
 * - No session validation here — that is the gateway's job (Wave 3) and this
 *   file must never become an auth oracle. A missing cookie bounces to
 *   /sign-in with ?next= so the round-trip preserves the destination.
 * - x-pathname is stamped for request-scoped logging/debugging.
 *
 * The session cookie name is better-auth's default (see
 * src/lib/auth-client.ts SESSION_COOKIE_NAME).
 */
const SESSION_COOKIE_NAME = "better-auth.session_token";

export default function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (!request.cookies.has(SESSION_COOKIE_NAME)) {
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
