import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { sign } from "@/lib/crypto";

// Checks the site password from the /gate form and mints the bb_gate cookie
// that src/proxy.ts verifies. Plain form POST + redirect — no client JS.
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const attempt = Buffer.from(String(form.get("password") ?? ""));
  const expected = Buffer.from(process.env.GATE_PASSWORD ?? "");

  const url = req.nextUrl.clone();
  url.search = "";

  if (
    expected.length === 0 ||
    attempt.length !== expected.length ||
    !timingSafeEqual(attempt, expected)
  ) {
    url.pathname = "/gate";
    url.search = "?error=1";
    return NextResponse.redirect(url, 303);
  }

  url.pathname = "/";
  const res = NextResponse.redirect(url, 303);
  res.cookies.set("bb_gate", sign("gate-ok"), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
