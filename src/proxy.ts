import { createHmac, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

// Optional site-wide password wall, for people who want their instance
// unlisted. Off unless GATE_PASSWORD is set, in every environment. When set,
// it runs before every route (Node runtime): no valid bb_gate cookie →
// redirect to /gate. Access control proper is X sign-in plus
// ALLOWED_X_USER_IDS; the gate is an extra layer on top, never a substitute.
//
// Kept self-contained (no imports from src/lib) per the proxy.ts guidance in
// node_modules/next/dist/docs — the token derivation below must stay in sync
// with sign() in src/lib/crypto.ts, which /api/gate uses to mint the cookie.

const GATE_COOKIE = "bb_gate";
const GATE_VALUE = "gate-ok";

// Paths that must work without the gate cookie:
//  /gate + /api/gate — the wall itself
//  /api/cron/…       — server-to-server, protected by its own CRON_SECRET bearer
//  /icon             — generated favicon (fetched by the browser on /gate too)
//  /api/mcp          — the assistant connector; carries its own lock (a personal
//                      access token, bearer only)
//  /api/episodes/<id>/audio|markdown — stable links an assistant shares; each
//                      carries its own lock (the session cookie or a bearer token)
// /.well-known/… never gets here: the matcher below skips any path with a dot.
const OPEN_PATHS = [
  /^\/gate$/,
  /^\/api\/gate$/,
  /^\/api\/cron\//,
  /^\/icon$/,
  /^\/api\/mcp$/,
  /^\/api\/episodes\/[^/]+\/(audio|markdown)$/,
];

function hasValidGateCookie(req: NextRequest): boolean {
  const secret = process.env.SESSION_SECRET;
  const token = req.cookies.get(GATE_COOKIE)?.value;
  if (!secret || !token) return false;
  const expected = Buffer.from(
    createHmac("sha256", secret).update(GATE_VALUE).digest("base64url")
  );
  const actual = Buffer.from(token);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function proxy(req: NextRequest) {
  // No GATE_PASSWORD → no wall, in development and production alike.
  if (!process.env.GATE_PASSWORD) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (OPEN_PATHS.some((re) => re.test(pathname))) return NextResponse.next();
  if (hasValidGateCookie(req)) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = "/gate";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  // Skip Next internals and public/ assets (everything with a file extension:
  // the landing video, logo, fonts). Route-level filtering happens above.
  matcher: ["/((?!_next/|.*\\..*).*)"],
};
