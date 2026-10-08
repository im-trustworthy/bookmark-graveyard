import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proxy } from "../../proxy";
import { sign } from "../crypto";

// The site password wall is optional: GATE_PASSWORD unset means no wall in
// every environment; set means every page redirects to /gate until the
// bb_gate cookie (minted by /api/gate) is valid.

const SESSION_SECRET = "proxy-test-session-secret";

// Minted exactly as /api/gate does: sign("gate-ok") = HMAC-SHA256 of
// "gate-ok" keyed with SESSION_SECRET, base64url-encoded.
function gateCookie(secret = SESSION_SECRET): string {
  return createHmac("sha256", secret).update("gate-ok").digest("base64url");
}

function request(path: string, cookie?: string): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    headers: cookie ? { cookie: `bb_gate=${cookie}` } : {},
  });
}

function passesThrough(res: Response): boolean {
  return res.headers.get("x-middleware-next") === "1";
}

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", SESSION_SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GATE_PASSWORD unset: no wall", () => {
  it.each(["development", "production"])("passes / through with NODE_ENV=%s", (nodeEnv) => {
    vi.stubEnv("NODE_ENV", nodeEnv);
    vi.stubEnv("GATE_PASSWORD", undefined);
    const res = proxy(request("/"));
    expect(res.status).toBe(200);
    expect(passesThrough(res)).toBe(true);
  });

  it("treats an empty GATE_PASSWORD as unset", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GATE_PASSWORD", "");
    expect(passesThrough(proxy(request("/")))).toBe(true);
  });
});

describe("GATE_PASSWORD set: the wall is on", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GATE_PASSWORD", "correct horse");
  });

  it("redirects / to /gate without a cookie", () => {
    const res = proxy(request("/?error=auth_failed"));
    expect([307, 308]).toContain(res.status);
    expect(res.headers.get("location")).toBe("http://localhost:3000/gate");
  });

  it.each(["/gate", "/api/gate", "/api/cron/sync", "/icon"])(
    "passes %s through without a cookie",
    (path) => {
      expect(passesThrough(proxy(request(path)))).toBe(true);
    }
  );

  it("passes / through with the cookie /api/gate mints", () => {
    // The proxy's own derivation must match src/lib/crypto.ts sign().
    expect(gateCookie()).toBe(sign("gate-ok"));
    const res = proxy(request("/", gateCookie()));
    expect(passesThrough(res)).toBe(true);
  });

  it.each([
    ["a garbage value", "not-the-cookie"],
    ["a cookie signed with another SESSION_SECRET", gateCookie("some-other-secret")],
  ])("redirects / to /gate with %s", (_label, cookie) => {
    const res = proxy(request("/", cookie));
    expect([307, 308]).toContain(res.status);
    expect(res.headers.get("location")).toBe("http://localhost:3000/gate");
  });
});
