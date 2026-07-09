import { NextRequest, NextResponse } from "next/server";
import { appUrl } from "@/lib/env";
import { db } from "@/lib/supabase";
import { setSession } from "@/lib/session";
import { exchangeCode, fetchMe, storeTokens } from "@/lib/x";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const verifier = req.cookies.get("bb_pkce")?.value;
  const expectedState = req.cookies.get("bb_state")?.value;

  if (!code || !verifier || !state || state !== expectedState) {
    return NextResponse.redirect(`${appUrl()}/?error=auth_failed`);
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
    if (!user.is_allowed) return NextResponse.redirect(`${appUrl()}/?error=not_allowed`);

    await storeTokens(user.id, tokens);
    await setSession(user.id);

    const res = NextResponse.redirect(appUrl());
    res.cookies.delete("bb_pkce");
    res.cookies.delete("bb_state");
    return res;
  } catch (err) {
    console.error("OAuth callback error:", err);
    return NextResponse.redirect(`${appUrl()}/?error=auth_failed`);
  }
}
