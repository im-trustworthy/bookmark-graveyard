import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createFakeDb } from "./fake-db";
import type { FakeDb } from "./fake-db";

const state = vi.hoisted(() => ({ db: null as unknown, sessions: [] as string[] }));
vi.mock("@/lib/supabase", () => ({ db: () => state.db }));
vi.mock("@/lib/session", () => ({
  setSession: async (userId: string) => {
    state.sessions.push(userId);
  },
}));
vi.mock("@/lib/x", () => ({
  generatePkce: () => ({ verifier: "test-verifier", challenge: "test-challenge", state: "test-state" }),
  authorizeUrl: (challenge: string, s: string) => `https://x.com/i/oauth2/authorize?code_challenge=${challenge}&state=${s}`,
  exchangeCode: async () => ({ access_token: "x-access", refresh_token: "x-refresh", expires_in: 7200 }),
  fetchMe: async () => ({ id: "x-1", username: "graveyard_fan", name: "Fan" }),
  storeTokens: async () => {},
}));

import { GET as loginRoute } from "@/app/api/auth/login/route";
import { GET as callbackRoute } from "@/app/api/auth/callback/x/route";
import { safeReturnPath } from "@/lib/return-path";

// X sign-in with a return path: /api/auth/login?next=… remembers where the
// sign-in started (the OAuth consent step) in the bb_next cookie, and the
// callback goes back there instead of the dashboard. Only same-origin paths.

const APP = "http://localhost:3000";
let fake: FakeDb;

/** The Set-Cookie entry for `name`, or undefined. */
function setCookie(res: Response, name: string): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
}

const login = (query = "") => loginRoute(new NextRequest(`${APP}/api/auth/login${query}`));

function callback(cookies: Record<string, string>, query = "?code=x-code&state=test-state") {
  const cookie = Object.entries(cookies)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("; ");
  return callbackRoute(new NextRequest(`${APP}/api/auth/callback/x${query}`, { headers: { cookie } }));
}

beforeEach(() => {
  fake = createFakeDb({ users: [{ id: "u1", x_user_id: "x-1", handle: "graveyard_fan", is_allowed: true }] });
  state.db = fake;
  state.sessions = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("safeReturnPath", () => {
  it.each([
    "/",
    "/oauth/authorize?x=1",
    "/oauth/authorize?response_type=code&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb&state=a%20b",
    "/dashboard#section",
  ])("accepts %j", (path) => {
    expect(safeReturnPath(path)).toBe(path);
  });

  it.each([
    ["a protocol-relative URL", "//evil.example"],
    ["a protocol-relative URL with a path", "//evil.example/oauth/authorize"],
    ["an absolute URL", "https://evil.example"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["a backslash", "/a\\b"],
    ["a backslash trick", "/\\evil.example"],
    ["a tab that a browser would strip", "/\t/evil.example"],
    ["a newline", "/a\nb"],
    ["a relative path", "oauth/authorize"],
    ["an empty string", ""],
    ["a very long path", `/${"a".repeat(2048)}`],
    ["a non-string", 42],
    ["nothing", null],
  ])("rejects %s", (_label, path) => {
    expect(safeReturnPath(path)).toBeNull();
  });
});

describe("GET /api/auth/login", () => {
  it("stores a valid next in bb_next (httpOnly, lax, ten minutes) and still goes to X", async () => {
    const next = "/oauth/authorize?x=1";
    const res = await login(`?next=${encodeURIComponent(next)}`);
    expect(res.headers.get("location")).toMatch(/^https:\/\/x\.com\/i\/oauth2\/authorize\?/);
    const cookie = setCookie(res, "bb_next");
    expect(cookie).toBeDefined();
    expect(decodeURIComponent(cookie!.split(";")[0].slice("bb_next=".length))).toBe(next);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Max-Age=600/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/Secure/i);
    expect(setCookie(res, "bb_pkce")).toBeDefined();
    expect(setCookie(res, "bb_state")).toBeDefined();
  });

  it("marks bb_next Secure in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await login(`?next=${encodeURIComponent("/oauth/authorize?x=1")}`);
    expect(setCookie(res, "bb_next")).toMatch(/Secure/i);
  });

  it.each(["//evil.example", "https://evil.example", "/a\\b"])("ignores next=%j and clears any old bb_next", async (next) => {
    const res = await login(`?next=${encodeURIComponent(next)}`);
    expect(res.headers.get("location")).toMatch(/^https:\/\/x\.com\//);
    const cookie = setCookie(res, "bb_next");
    expect(cookie).toMatch(/^bb_next=;/);
    expect(cookie).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);
  });

  it("clears any old bb_next when there is no next", async () => {
    expect(setCookie(await login(), "bb_next")).toMatch(/^bb_next=;/);
  });
});

describe("GET /api/auth/callback/x", () => {
  const pkce = { bb_pkce: "test-verifier", bb_state: "test-state" };

  it("goes back to bb_next after signing in, and clears it", async () => {
    const next = "/oauth/authorize?response_type=code&state=a%20b";
    const res = await callback({ ...pkce, bb_next: next });
    expect(state.sessions).toEqual(["u1"]);
    expect(res.headers.get("location")).toBe(`${APP}${next}`);
    expect(setCookie(res, "bb_next")).toMatch(/^bb_next=;/);
    expect(setCookie(res, "bb_pkce")).toMatch(/^bb_pkce=;/);
  });

  it("goes to the dashboard without bb_next", async () => {
    const res = await callback(pkce);
    expect(state.sessions).toEqual(["u1"]);
    expect(res.headers.get("location")).toBe(`${APP}/`);
    expect(setCookie(res, "bb_next")).toMatch(/^bb_next=;/);
  });

  it.each(["//evil.example/x", "https://evil.example", "/a\\b"])(
    "ignores a bb_next of %j that didn't come from the login route",
    async (bad) => {
      const res = await callback({ ...pkce, bb_next: bad });
      expect(res.headers.get("location")).toBe(`${APP}/`);
      expect(setCookie(res, "bb_next")).toMatch(/^bb_next=;/);
    }
  );

  it("clears bb_next on a failed sign-in too", async () => {
    const res = await callback({ ...pkce, bb_next: "/oauth/authorize?x=1" }, "?code=x-code&state=wrong");
    expect(res.headers.get("location")).toBe(`${APP}/?error=auth_failed`);
    expect(setCookie(res, "bb_next")).toMatch(/^bb_next=;/);
    expect(state.sessions).toEqual([]);
  });

  it("clears bb_next for someone who isn't allowed", async () => {
    vi.stubEnv("ALLOWED_X_USER_IDS", "someone-else");
    const res = await callback({ ...pkce, bb_next: "/oauth/authorize?x=1" });
    expect(res.headers.get("location")).toBe(`${APP}/?error=not_allowed`);
    expect(setCookie(res, "bb_next")).toMatch(/^bb_next=;/);
    expect(state.sessions).toEqual([]);
  });
});
