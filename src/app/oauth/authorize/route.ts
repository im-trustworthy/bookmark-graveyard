import { NextRequest, NextResponse } from "next/server";
import { checkAuthorizeRequest, issuer, loginUrl, oauthErrorPage } from "@/lib/oauth";
import { getSessionUserId } from "@/lib/session";

// The authorization endpoint (RFC 6749 §3.1), reached by the browser. It is a
// route handler rather than the consent page itself because it must answer
// with real status codes, which a page can't: 400 for the error page and 302
// for redirects (a page's redirect() is a 307).
//
// 1. Anything wrong with the request: 400 error page, never a redirect to the
//    client. Anyone can register a client with any redirect URI, so an
//    automatic error redirect would make this domain an open redirector
//    (RFC 9700 §4.11). When the client and redirect_uri check out, the page
//    offers a link back carrying error, error_description and state; the user
//    decides whether to follow it.
// 2. Not signed in: 302 to the X sign-in, which comes back here afterwards.
// 3. Otherwise: 302 to the consent page with the same query, which checks it
//    again and asks the user.

export async function GET(req: NextRequest) {
  let check;
  try {
    check = await checkAuthorizeRequest(req.nextUrl.searchParams);
  } catch (err) {
    console.error("GET /oauth/authorize:", err);
    return oauthErrorPage("Something went wrong on our side. Try again in a minute.", 500);
  }

  if (!check.ok) return oauthErrorPage(check.message, 400, check.returnTo);

  const query = req.nextUrl.search;
  if (!(await getSessionUserId())) return NextResponse.redirect(loginUrl(`/oauth/authorize${query}`), 302);
  return NextResponse.redirect(`${issuer()}/oauth/authorize/consent${query}`, 302);
}
