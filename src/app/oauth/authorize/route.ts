import { NextRequest, NextResponse } from "next/server";
import { checkAuthorizeRequest, issuer, loginUrl, oauthErrorPage, withParams } from "@/lib/oauth";
import { getSessionUserId } from "@/lib/session";

// The authorization endpoint (RFC 6749 §3.1), reached by the browser. It is a
// route handler rather than the consent page itself because it must answer
// with real status codes, which a page can't: 400 for the error page and 302
// for redirects (a page's redirect() is a 307).
//
// 1. Unknown client, or a redirect_uri the client didn't register: 400 error
//    page, never a redirect, since the target can't be trusted.
// 2. Anything else wrong: 302 back to the client with error, error_description
//    and state.
// 3. Not signed in: 302 to the X sign-in, which comes back here afterwards.
// 4. Otherwise: 302 to the consent page with the same query, which checks it
//    again and asks the user.

export async function GET(req: NextRequest) {
  let check;
  try {
    check = await checkAuthorizeRequest(req.nextUrl.searchParams);
  } catch (err) {
    console.error("GET /oauth/authorize:", err);
    return oauthErrorPage("Something went wrong on our side. Try again in a minute.", 500);
  }

  if (!check.ok && !check.redirect) return oauthErrorPage(check.message, 400);
  if (!check.ok) {
    const target = withParams(check.redirectUri, {
      error: check.error,
      error_description: check.description,
      state: check.state,
    });
    return NextResponse.redirect(target, 302);
  }

  const query = req.nextUrl.search;
  if (!(await getSessionUserId())) return NextResponse.redirect(loginUrl(`/oauth/authorize${query}`), 302);
  return NextResponse.redirect(`${issuer()}/oauth/authorize/consent${query}`, 302);
}
