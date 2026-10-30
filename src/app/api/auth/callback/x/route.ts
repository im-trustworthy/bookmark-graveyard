import { NextRequest, NextResponse } from "next/server";
import { appUrl } from "@/lib/env";
import { RETURN_PATH_COOKIE, safeReturnPath } from "@/lib/return-path";
import { db } from "@/lib/supabase";
import { setSession } from "@/lib/session";
import { exchangeCode, fetchMe, storeTokens } from "@/lib/x";

// Fixed, closed set of redirect codes — never build this from a caught error's
// message or any request-derived value, so nothing sensitive can leak into a URL
// that ends up in browser history / referrer headers / server access logs.
type AuthErrorCode = "auth_failed" | "not_allowed";

/** Clears the one-shot sign-in cookies: the PKCE pair and the return path. */
function clearSignInCookies(res: NextResponse): NextResponse {
  res.cookies.delete("bb_pkce");
  res.cookies.delete("bb_state");
  res.cookies.delete(RETURN_PATH_COOKIE);
  return res;
}

function authErrorRedirect(code: AuthErrorCode): NextResponse {
  // Clear the one-shot cookies on every exit path, not just success — see the
  // state-comparison note below for why that matters beyond plain cleanliness.
  return clearSignInCookies(NextResponse.redirect(`${appUrl()}/?error=${code}`));
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const verifier = req.cookies.get("bb_pkce")?.value;
  const expectedState = req.cookies.get("bb_state")?.value;

  // Plain `!==` (not timingSafeEqual) is safe here: `state` is a fresh 16-byte
  // random nonce per login attempt, and — because authErrorRedirect deletes
  // bb_state unconditionally on every path below, including this mismatch check —
  // it is single-use no matter the outcome. A timing attack needs many comparisons
  // against the same fixed secret to extract it byte-by-byte; here the secret is
  // discarded after the first attempt, so there's nothing to accumulate signal
  // against. Contrast with the session HMAC in lib/crypto.ts (verifySignature),
  // which guards a long-lived, replayable cookie and does need timingSafeEqual.
  if (!code || !verifier || !state || state !== expectedState) {
    return authErrorRedirect("auth_failed");
  }

  try {
    const tokens = await exchangeCode(code, verifier);
    const me = await fetchMe(tokens.access_token);

    const allowlist = (process.env.ALLOWED_X_USER_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    // Empty allowlist = personal mode: whoever logs in is allowed.
    const isAllowed = allowlist.length === 0 || allowlist.includes(me.id);

    const { data: user, error } = await db()
      .from("users")
      .upsert(
        {
          x_user_id: me.id,
          handle: me.username,
          display_name: me.name,
          avatar_url: me.profile_image_url ?? null,
          is_allowed: isAllowed,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "x_user_id" }
      )
      .select("id, is_allowed")
      .single();
    if (error || !user) throw new Error(error?.message ?? "upsert failed");
    if (!user.is_allowed) return authErrorRedirect("not_allowed");

    await storeTokens(user.id, tokens);
    await setSession(user.id);

    // No open redirect: bb_next is only ever a path on this app (checked again
    // here, not just when /api/auth/login set it), appended to APP_URL.
    const next = safeReturnPath(req.cookies.get(RETURN_PATH_COOKIE)?.value);
    const target = next ? `${appUrl().replace(/\/+$/, "")}${next}` : appUrl();
    return clearSignInCookies(NextResponse.redirect(target));
  } catch (err) {
    // Detail stays server-side; the redirect only ever carries the fixed code.
    console.error("OAuth callback error:", err);
    return authErrorRedirect("auth_failed");
  }
}
