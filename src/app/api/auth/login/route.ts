import { NextRequest, NextResponse } from "next/server";
import { RETURN_PATH_COOKIE, safeReturnPath } from "@/lib/return-path";
import { authorizeUrl, generatePkce } from "@/lib/x";

// No open-redirect risk: the redirect target is built solely from server config
// + a freshly generated PKCE challenge/state. The one request input, `next`
// (where to go after sign-in, e.g. back to the OAuth consent step), is only
// stored in the bb_next cookie, and only when safeReturnPath accepts it as a
// path on this app; the callback checks it again before using it.
export async function GET(req: NextRequest) {
  const { verifier, challenge, state } = generatePkce();
  const res = NextResponse.redirect(authorizeUrl(challenge, state));
  const cookieOpts = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  };
  res.cookies.set("bb_pkce", verifier, cookieOpts);
  res.cookies.set("bb_state", state, cookieOpts);
  const next = safeReturnPath(req.nextUrl.searchParams.get("next"));
  if (next) res.cookies.set(RETURN_PATH_COOKIE, next, cookieOpts);
  else res.cookies.delete(RETURN_PATH_COOKIE); // a stale one from an abandoned sign-in
  return res;
}
