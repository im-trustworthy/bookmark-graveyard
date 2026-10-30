import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { sign } from "@/lib/crypto";
import { appUrl } from "@/lib/env";
import { safeReturnPath } from "@/lib/return-path";

// Checks the site password from the /gate form and mints the bb_gate cookie
// that src/proxy.ts verifies. Plain form POST + redirect — no client JS.
// The form carries `next`, the path the proxy blocked; after the right
// password the browser goes back there (only when safeReturnPath accepts it as
// a path on this app, so it can't become an open redirect), else to /.
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const attempt = Buffer.from(String(form.get("password") ?? ""));
  const expected = Buffer.from(process.env.GATE_PASSWORD ?? "");
  const next = safeReturnPath(form.get("next"));

  const url = req.nextUrl.clone();
  url.search = "";

  if (
    expected.length === 0 ||
    attempt.length !== expected.length ||
    !timingSafeEqual(attempt, expected)
  ) {
    url.pathname = "/gate";
    url.searchParams.set("error", "1");
    if (next) url.searchParams.set("next", next);
    return NextResponse.redirect(url, 303);
  }

  url.pathname = "/";
  const res = NextResponse.redirect(next ? `${appUrl().replace(/\/+$/, "")}${next}` : url, 303);
  res.cookies.set("bb_gate", sign("gate-ok"), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
