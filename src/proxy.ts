import { createHmac, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

// Site-wide password wall for hosting this instance off a private tab of a
// public website. Runs before every route (Node runtime): no valid bb_gate
// cookie → redirect to /gate. The X-OAuth allowlist still guards the actual
// account data behind this wall; the gate just keeps the whole app unlisted.
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
const OPEN_PATHS = [/^\/gate$/, /^\/api\/gate$/, /^\/api\/cron\//, /^\/icon$/];

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
  const password = process.env.GATE_PASSWORD;
  if (!password) {
    // Same fail-closed stance as CRON_SECRET in api/cron/sync: a deployed
    // instance without a configured password stays sealed, not wide open.
    // Local dev (no GATE_PASSWORD in .env.local) skips the gate entirely.
    if (process.env.NODE_ENV === "production") {
      return new NextResponse("GATE_PASSWORD not configured", { status: 503 });
    }
    return NextResponse.next();
  }

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
