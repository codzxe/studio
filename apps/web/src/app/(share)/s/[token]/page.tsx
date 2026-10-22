import { ShareReview } from "@/components/share/share-review";
import { gatewayCall, isGatewayNotFound } from "@/lib/gateway";
import type { ShareInfo } from "@studio/contracts";
import { notFound } from "next/navigation";

/**
 * The public share/review route — /s/:token (BUILD_PLAN §M7 task 5).
 *
 * RSC shell: it reads the PUBLIC share metadata through the gateway seam and
 * hands the interactive review surface to the client component. The share
 * meta read needs NO password (that's the point — `ShareInfo.hasPassword`
 * is what the password prompt renders from), and every other content call
 * (manifest/comments/guest posts/request-access) is the anonymous client's,
 * authenticated by the token (+ `x-share-password` header via the api-client).
 *
 * NO editor wasm ever loads here — the client surface is a review player
 * (see components/share/*). Unknown, malformed, expired or revoked tokens
 * are §12.1 404s at THIS boundary: a stranger must not learn whether a link
 * existed.
 */

/**
 * Share-token URL shape, restated (mirrors contracts
 * `SHARE_TOKEN_PATH_SCHEMA`: url-safe base64 chars, 16–128 long). A
 * runtime contracts import is banned in apps/web (NodeNext barrel), and the
 * gateway re-validates on every call anyway — this is a cheap pre-filter so
 * hostile URLs die before a gateway round-trip.
 */
const SHARE_TOKEN_URL_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;

export default async function SharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (!SHARE_TOKEN_URL_SHAPE.test(token)) {
    notFound();
  }

  let info: ShareInfo;
  try {
    // `token` passed the url-safe shape above; the gateway 404s the rest.
    info = await gatewayCall<ShareInfo>(`/v1/share/${token}`);
  } catch (error) {
    // Expired/revoked/unknown = §12.1 404 (never a 403, never an oracle).
    if (isGatewayNotFound(error)) {
      notFound();
    }
    throw error;
  }

  return <ShareReview token={token} info={info} />;
}
