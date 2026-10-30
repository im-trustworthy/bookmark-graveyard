import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./fake-db";
import type { FakeDb } from "./fake-db";

const state = vi.hoisted(() => ({ db: null as unknown, userId: null as string | null }));
vi.mock("@/lib/session", () => ({ getSessionUserId: async () => state.userId }));
vi.mock("@/lib/supabase", () => ({ db: () => state.db }));

import { mintApiToken, revokeApiToken } from "@/lib/api-tokens";
import { bearerToken, getBearerUser, getUserIdFromRequest } from "@/lib/auth";

let fake: FakeDb;
let readToken: { token: string; id: string };
let writeToken: { token: string; id: string };

function req(authorization?: string): Request {
  return new Request("http://localhost/api/anything", {
    headers: authorization === undefined ? {} : { authorization },
  });
}

beforeEach(async () => {
  fake = createFakeDb({
    users: [
      { id: "cookie-user", is_allowed: true },
      { id: "token-user", is_allowed: true },
    ],
    api_tokens: [],
  });
  state.db = fake;
  state.userId = null;
  const r = await mintApiToken("token-user", { name: "reader", scopes: ["read"] });
  const w = await mintApiToken("token-user", { name: "writer", scopes: ["write"] });
  readToken = { token: r.token, id: r.record.id };
  writeToken = { token: w.token, id: w.record.id };
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("bearerToken", () => {
  it("reads the Bearer scheme in any case and trims the token", () => {
    expect(bearerToken(req("Bearer abc"))).toBe("abc");
    expect(bearerToken(req("bearer abc"))).toBe("abc");
    expect(bearerToken(req("BEARER abc"))).toBe("abc");
    expect(bearerToken(req("  BeArEr    abc   "))).toBe("abc");
  });

  it("ignores other schemes, a bare token and an empty one", () => {
    for (const header of [undefined, "", "Bearer", "Bearer    ", "Basic abc", "Token abc", "abc", "Bearerabc"]) {
      expect(bearerToken(req(header)), String(header)).toBeNull();
    }
  });
});

describe("getUserIdFromRequest", () => {
  it("prefers the session cookie, which carries both scopes, and doesn't look at the token", async () => {
    state.userId = "cookie-user";
    const fromSpy = vi.spyOn(fake, "from");
    for (const scope of ["read", "write"] as const) {
      expect(await getUserIdFromRequest(req(`Bearer ${readToken.token}`), { scope })).toEqual({
        userId: "cookie-user",
        via: "cookie",
        scopes: ["read", "write"],
      });
    }
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("falls back to the bearer token, whatever the scheme's case", async () => {
    for (const scheme of ["Bearer", "bearer", "BEARER"]) {
      expect(await getUserIdFromRequest(req(`${scheme} ${writeToken.token} `), { scope: "write" })).toEqual({
        userId: "token-user",
        via: "token",
        scopes: ["read", "write"],
        tokenId: writeToken.id,
      });
    }
  });

  it("rejects a token without the needed scope; write covers read", async () => {
    expect(await getUserIdFromRequest(req(`Bearer ${readToken.token}`), { scope: "write" })).toBeNull();
    expect(await getUserIdFromRequest(req(`Bearer ${readToken.token}`), { scope: "read" })).toMatchObject({
      userId: "token-user",
      scopes: ["read"],
    });
    expect(await getUserIdFromRequest(req(`Bearer ${writeToken.token}`), { scope: "read" })).toMatchObject({
      userId: "token-user",
    });
  });

  it("is null with neither, with a bad token, or with a revoked one", async () => {
    expect(await getUserIdFromRequest(req(), { scope: "read" })).toBeNull();
    expect(await getUserIdFromRequest(req(`Bearer bg_${"x".repeat(43)}`), { scope: "read" })).toBeNull();
    await revokeApiToken("token-user", readToken.id);
    expect(await getUserIdFromRequest(req(`Bearer ${readToken.token}`), { scope: "read" })).toBeNull();
  });
});

describe("getBearerUser", () => {
  it("ignores the session cookie entirely", async () => {
    state.userId = "cookie-user";
    expect(await getBearerUser(req(), "read")).toBeNull();
    expect(await getBearerUser(req(`Bearer ${writeToken.token}`), "write")).toEqual({
      userId: "token-user",
      via: "token",
      scopes: ["read", "write"],
      tokenId: writeToken.id,
    });
  });

  it("checks the scope", async () => {
    expect(await getBearerUser(req(`Bearer ${readToken.token}`), "write")).toBeNull();
    expect(await getBearerUser(req(`bearer ${readToken.token}`), "read")).toMatchObject({ tokenId: readToken.id });
  });
});
