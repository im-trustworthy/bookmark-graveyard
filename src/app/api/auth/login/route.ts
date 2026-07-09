import { NextResponse } from "next/server";
import { authorizeUrl, generatePkce } from "@/lib/x";

// No open-redirect risk: no request input is read here — the redirect target is built
// solely from server config + a freshly generated PKCE challenge/state.
export async function GET() {
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
  return res;
}
