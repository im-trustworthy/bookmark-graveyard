import { NextRequest, NextResponse } from "next/server";
import {
  getClient,
  issueAuthorizationCode,
  issuer,
  isUserAllowed,
  oauthErrorPage,
  openConsent,
  redirectUriMatches,
  withParams,
} from "@/lib/oauth";
import { getSessionUserId } from "@/lib/session";

// The consent form's POST (a plain form post, no client JS). Everything is
// checked again here, from the signed blob alone: what the user approved can't
// be changed by editing the form, it must be the signed-in user's own request,
// fresh (ten minutes), for a client that still exists with that redirect URI
// still registered. Approve stores a single-use code (hashed, five minutes) and
// sends the browser back to the client with code and state; Deny sends back
// access_denied. 303, so the browser follows with a GET.

const REDIRECT_HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

function backToClient(target: string): NextResponse {
  return NextResponse.redirect(target, { status: 303, headers: REDIRECT_HEADERS });
}

export async function POST(req: NextRequest) {
  // Same-origin form posts only, like Next's own check for Server Actions. The
  // session cookie is SameSite=Lax and the blob is bound to the user, so this
  // is a second lock, not the only one.
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(issuer()).origin) {
    return oauthErrorPage("The approval didn't come from this site's approval page.", 403);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return oauthErrorPage("The approval form couldn't be read.", 400);
  }
  const grant = openConsent(form.get("consent"));
  if (!grant) return oauthErrorPage("This approval request is invalid or has expired.", 400);
  const decision = form.get("decision");
  if (decision !== "approve" && decision !== "deny") return oauthErrorPage("Choose Approve or Deny.", 400);

  const userId = await getSessionUserId();
  if (!userId || userId !== grant.userId) {
    return oauthErrorPage("You're no longer signed in as the account this request was made for.", 403);
  }

  let target: string;
  try {
    const client = await getClient(grant.clientId);
    if (!client || !redirectUriMatches(client.redirect_uris, grant.redirectUri)) {
      return oauthErrorPage("The app asking for access isn't registered here any more.", 400);
    }
    if (decision === "deny") {
      target = withParams(grant.redirectUri, {
        error: "access_denied",
        error_description: "The user denied the request",
        state: grant.state,
      });
    } else if (!(await isUserAllowed(userId))) {
      return oauthErrorPage("Your account can't use this Bookmark Graveyard.", 403);
    } else {
      const code = await issueAuthorizationCode(grant);
      target = withParams(grant.redirectUri, { code, state: grant.state });
    }
  } catch (err) {
    console.error("POST /api/oauth/decision:", err);
    return oauthErrorPage("Something went wrong on our side. Try again in a minute.", 500);
  }
  return backToClient(target);
}
