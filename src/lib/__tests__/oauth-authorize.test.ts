import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { createFakeDb } from "./fake-db";
import type { FakeDb } from "./fake-db";
import {
  APP,
  authorizeQuery,
  CLIENT_ID,
  formPost,
  locationOf,
  OTHER_CLIENT_ID,
  OTHER_USER_ID,
  oauthTables,
  pkcePair,
  REDIRECT,
  RESOURCE,
  sha256Hex,
  USER_ID,
} from "./oauth-fixtures";

const state = vi.hoisted(() => ({ db: null as unknown, userId: null as string | null }));
vi.mock("@/lib/session", () => ({ getSessionUserId: async () => state.userId }));
vi.mock("@/lib/supabase", () => ({ db: () => state.db }));

import { GET as authorizeRoute } from "@/app/oauth/authorize/route";
import ConsentPage from "@/app/oauth/authorize/consent/page";
import { POST as decisionRoute } from "@/app/api/oauth/decision/route";
import { checkAuthorizeRequest, openConsent, sealConsent } from "@/lib/oauth";
import type { AuthorizeRequest } from "@/lib/oauth";

// The browser half of the flow: GET /oauth/authorize (validation, sign-in,
// hand-off to the consent page), the consent page itself, and the decision
// POST that turns an approval into a single-use code.

const T0 = new Date("2026-10-29T12:00:00.000Z");
const MINUTE = 60 * 1000;

let fake: FakeDb;

const authorize = (query: URLSearchParams | string) =>
  authorizeRoute(new NextRequest(`${APP}/oauth/authorize?${query}`));

async function renderConsent(query: URLSearchParams): Promise<string> {
  const searchParams: Record<string, string | string[]> = {};
  for (const key of new Set(query.keys())) {
    const all = query.getAll(key);
    searchParams[key] = all.length > 1 ? all : all[0];
  }
  return renderToStaticMarkup(await ConsentPage({ searchParams: Promise.resolve(searchParams) }));
}

const consentField = (html: string) => html.match(/name="consent" value="([^"]+)"/)?.[1] ?? null;

const decide = (consent: string, decision: string, headers: Record<string, string> = { Origin: APP }) =>
  decisionRoute(formPost(`${APP}/api/oauth/decision`, { consent, decision }, headers));

function validRequest(overrides: Partial<AuthorizeRequest> = {}): AuthorizeRequest {
  return {
    clientId: CLIENT_ID,
    clientName: "Claude",
    redirectUri: REDIRECT,
    scopes: ["read"],
    state: "st-123",
    codeChallenge: pkcePair().challenge,
    resource: RESOURCE,
    ...overrides,
  };
}

/** What a thrown redirect() points at, or null when `fn` didn't redirect. */
async function redirectTarget(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    const digest = (err as { digest?: string }).digest ?? "";
    if (!digest.startsWith("NEXT_REDIRECT")) throw err;
    return digest.split(";")[2];
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  fake = createFakeDb(oauthTables());
  state.db = fake;
  state.userId = USER_ID;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GET /oauth/authorize: an untrusted redirect target gets an error page, never a redirect", () => {
  it.each([
    ["an unknown client_id", { client_id: "u".repeat(43) }],
    ["a client_id that isn't even shaped like one", { client_id: "nope" }],
    ["no client_id", { client_id: null }],
    ["a redirect_uri the client didn't register", { redirect_uri: "https://evil.example/callback" }],
    ["another client's redirect_uri", { redirect_uri: "https://other.example/callback" }],
    ["a registered redirect_uri with an extra path", { redirect_uri: `${REDIRECT}/extra` }],
    ["a registered redirect_uri with an added query", { redirect_uri: `${REDIRECT}?x=1` }],
    ["a different scheme on the registered host", { redirect_uri: REDIRECT.replace("https:", "http:") }],
    ["no redirect_uri", { redirect_uri: null }],
  ])("%s → 400 page", async (_label, overrides) => {
    const res = await authorize(authorizeQuery(overrides));
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    const html = await res.text();
    expect(html).toContain("can't be completed");
    expect(html).not.toContain("evil.example");
  });

  it("treats a repeated client_id or redirect_uri as untrusted", async () => {
    const query = authorizeQuery();
    query.append("redirect_uri", "https://evil.example/callback");
    const res = await authorize(query);
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("answers 500 without redirecting when the database can't be asked", async () => {
    state.db = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "down" } }) }) }) }) };
    const res = await authorize(authorizeQuery());
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("GET /oauth/authorize: other problems go back to the client", () => {
  it.each([
    ["no code_challenge", { code_challenge: null }, "invalid_request"],
    ["a code_challenge that's too short", { code_challenge: "a".repeat(42) }, "invalid_request"],
    ["a code_challenge with a bad character", { code_challenge: `${"a".repeat(42)}+` }, "invalid_request"],
    ["no code_challenge_method", { code_challenge_method: null }, "invalid_request"],
    ["the plain method", { code_challenge_method: "plain" }, "invalid_request"],
    ["a lowercase method", { code_challenge_method: "s256" }, "invalid_request"],
    ["no response_type", { response_type: null }, "invalid_request"],
    ["the implicit flow", { response_type: "token" }, "unsupported_response_type"],
    ["an unknown scope", { scope: "read admin" }, "invalid_scope"],
    ["an OpenID scope", { scope: "openid" }, "invalid_scope"],
    ["a scope in the wrong case", { scope: "READ" }, "invalid_scope"],
    ["another resource", { resource: "https://evil.example/api/mcp" }, "invalid_target"],
    ["the app root as the resource", { resource: APP }, "invalid_target"],
    ["a resource with a different path", { resource: `${APP}/api/mcpx` }, "invalid_target"],
  ])("%s → 302 with %s", async (_label, overrides, error) => {
    const res = await authorize(authorizeQuery(overrides));
    expect(res.status).toBe(302);
    const target = locationOf(res);
    expect(`${target.origin}${target.pathname}`).toBe(REDIRECT);
    expect(target.searchParams.get("error")).toBe(error);
    expect(target.searchParams.get("error_description")).toEqual(expect.any(String));
    expect(target.searchParams.get("state")).toBe("st-123");
    expect(target.searchParams.has("code")).toBe(false);
  });

  it("keeps a query string the client registered, and leaves state out when none was sent", async () => {
    fake.tables.oauth_clients[0].redirect_uris = ["https://claude.ai/cb?tenant=a b&x=1"];
    const res = await authorize(
      authorizeQuery({ redirect_uri: "https://claude.ai/cb?tenant=a b&x=1", state: null, code_challenge_method: "plain" })
    );
    const target = locationOf(res);
    expect(target.searchParams.get("tenant")).toBe("a b");
    expect(target.searchParams.get("x")).toBe("1");
    expect(target.searchParams.get("error")).toBe("invalid_request");
    expect(target.searchParams.has("state")).toBe(false);
  });

  it("echoes state verbatim", async () => {
    const weird = "a b&c=d/é?#%";
    const target = locationOf(await authorize(authorizeQuery({ state: weird, scope: "admin" })));
    expect(target.searchParams.get("state")).toBe(weird);
  });

  it("rejects a repeated parameter with invalid_request", async () => {
    const query = authorizeQuery();
    query.append("scope", "write");
    const target = locationOf(await authorize(query));
    expect(target.searchParams.get("error")).toBe("invalid_request");
    expect(target.searchParams.get("error_description")).toMatch(/scope/);
  });

  it("returns errors to a custom-scheme redirect too", async () => {
    const uri = "cursor://anysphere.cursor-mcp/oauth/callback";
    const target = locationOf(await authorize(authorizeQuery({ redirect_uri: uri, response_type: "token" })));
    expect(target.protocol).toBe("cursor:");
    expect(target.searchParams.get("error")).toBe("unsupported_response_type");
  });
});

describe("GET /oauth/authorize: a valid request", () => {
  it("sends someone who isn't signed in to the X sign-in, coming back here", async () => {
    state.userId = null;
    const query = authorizeQuery();
    const res = await authorize(query);
    expect(res.status).toBe(302);
    const target = locationOf(res);
    expect(`${target.origin}${target.pathname}`).toBe(`${APP}/api/auth/login`);
    expect(target.searchParams.get("next")).toBe(`/oauth/authorize?${query}`);
    // URL-encoded: the whole return path is one parameter.
    expect(res.headers.get("location")).toBe(`${APP}/api/auth/login?next=${encodeURIComponent(`/oauth/authorize?${query}`)}`);
  });

  it("sends a signed-in user to the consent page with the same query", async () => {
    const query = authorizeQuery();
    const res = await authorize(query);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${APP}/oauth/authorize/consent?${query}`);
  });

  it.each([
    ["no scope, which means read", { scope: null }, ["read"]],
    ["read", { scope: "read" }, ["read"]],
    ["write, which implies read", { scope: "write" }, ["read", "write"]],
    ["read write", { scope: "read write" }, ["read", "write"]],
    ["no resource", { resource: null }, ["read"]],
    ["the resource with a trailing slash", { resource: `${RESOURCE}/` }, ["read"]],
  ])("accepts %s", async (_label, overrides, scopes) => {
    const query = authorizeQuery(overrides);
    expect((await authorize(query)).headers.get("location")).toMatch(/\/oauth\/authorize\/consent\?/);
    const check = await checkAuthorizeRequest(query);
    expect(check.ok && check.request.scopes).toEqual(scopes);
  });

  it("lets a loopback redirect use another port (RFC 8252), but not another path or host", async () => {
    const ok = await authorize(authorizeQuery({ redirect_uri: "http://localhost:51234/oauth/callback" }));
    expect(ok.headers.get("location")).toMatch(/\/oauth\/authorize\/consent\?/);
    expect((await authorize(authorizeQuery({ redirect_uri: "http://localhost:51234/other" }))).status).toBe(400);
    expect((await authorize(authorizeQuery({ redirect_uri: "http://127.0.0.1:6274/oauth/callback" }))).status).toBe(400);
  });
});

describe("the consent page", () => {
  it("names the app, the scopes in plain words, the account and where the user goes next", async () => {
    const html = await renderConsent(authorizeQuery({ scope: "read" }));
    expect(html).toContain("Bookmark Graveyard");
    expect(html).toContain("Connect Claude?");
    expect(html).toContain("Claude wants to:");
    expect(html).toContain("search and read your bookmarks and briefs");
    expect(html).not.toContain("also start briefs");
    expect(html).toContain("@graveyard_fan");
    expect(html).toContain("claude.ai");
    expect(html).toMatch(/<form [^>]*action="\/api\/oauth\/decision"/);
    expect(html).toMatch(/<form [^>]*method="POST"/);
    expect(html).toContain('value="approve"');
    expect(html).toContain('value="deny"');
  });

  it("spells out what write costs", async () => {
    const html = await renderConsent(authorizeQuery({ scope: "write" }));
    expect(html).toContain("search and read your bookmarks and briefs");
    expect(html).toContain("also start briefs, which spends your daily allowance and credits, and hide bookmarks");
  });

  it("escapes a hostile client name", async () => {
    fake.tables.oauth_clients[0].client_name = '<img src=x onerror="alert(1)">';
    const html = await renderConsent(authorizeQuery());
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("carries the validated request in a signed blob bound to the user, valid for ten minutes", async () => {
    const { challenge } = pkcePair();
    const html = await renderConsent(authorizeQuery({ scope: "write", code_challenge: challenge }));
    const blob = consentField(html);
    expect(blob).not.toBeNull();
    expect(openConsent(blob)).toEqual({
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      scopes: ["read", "write"],
      state: "st-123",
      codeChallenge: challenge,
      resource: RESOURCE,
      userId: USER_ID,
      expiresAt: T0.getTime() + 10 * MINUTE,
    });
  });

  it("sends someone who isn't signed in to sign in, coming back to /oauth/authorize", async () => {
    state.userId = null;
    const query = authorizeQuery();
    const target = await redirectTarget(() => renderConsent(query));
    expect(target).toBe(`${APP}/api/auth/login?next=${encodeURIComponent(`/oauth/authorize?${query}`)}`);
  });

  it("checks the request again when opened directly, and never redirects to the client", async () => {
    const cases: Record<string, string>[] = [{ redirect_uri: "https://evil.example/cb" }, { code_challenge_method: "plain" }];
    for (const overrides of cases) {
      const html = await renderConsent(authorizeQuery(overrides));
      expect(html).toContain("can&#x27;t be completed");
      expect(consentField(html)).toBeNull();
    }
  });

  it("refuses an account that is no longer allowed", async () => {
    fake.tables.users[0].is_allowed = false;
    const html = await renderConsent(authorizeQuery());
    expect(consentField(html)).toBeNull();
    expect(html).toContain("can&#x27;t use this Bookmark Graveyard");
  });
});

describe("the consent blob", () => {
  it("round-trips", () => {
    const request = validRequest({ state: null, resource: null });
    expect(openConsent(sealConsent(request, USER_ID))).toMatchObject({ state: null, resource: null, userId: USER_ID });
  });

  it("rejects any change to its body or signature", () => {
    const blob = sealConsent(validRequest(), USER_ID);
    const [body, signature] = blob.split(".");
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    const forged = (changes: Record<string, unknown>) =>
      `${Buffer.from(JSON.stringify({ ...payload, ...changes })).toString("base64url")}.${signature}`;

    expect(openConsent(forged({ scopes: ["read", "write"] }))).toBeNull();
    expect(openConsent(forged({ redirectUri: "https://evil.example/cb" }))).toBeNull();
    expect(openConsent(forged({ userId: OTHER_USER_ID }))).toBeNull();
    expect(openConsent(forged({ expiresAt: T0.getTime() + 999 * MINUTE }))).toBeNull();
    expect(openConsent(`${body}.${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`)).toBeNull();
    expect(openConsent(body)).toBeNull();
    expect(openConsent("")).toBeNull();
    expect(openConsent(null)).toBeNull();
  });

  it("expires after ten minutes", () => {
    const blob = sealConsent(validRequest(), USER_ID);
    vi.setSystemTime(T0.getTime() + 10 * MINUTE - 1);
    expect(openConsent(blob)).not.toBeNull();
    vi.setSystemTime(T0.getTime() + 10 * MINUTE);
    expect(openConsent(blob)).toBeNull();
  });
});

describe("POST /api/oauth/decision", () => {
  it("on approve, stores a hashed single-use code for five minutes and 303s back with code and state", async () => {
    const request = validRequest({ scopes: ["read", "write"] });
    const res = await decide(sealConsent(request, USER_ID), "approve");
    expect(res.status).toBe(303);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const target = locationOf(res);
    expect(`${target.origin}${target.pathname}`).toBe(REDIRECT);
    expect(target.searchParams.get("state")).toBe("st-123");
    const code = target.searchParams.get("code")!;
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);

    expect(fake.tables.oauth_codes).toHaveLength(1);
    expect(fake.tables.oauth_codes[0]).toMatchObject({
      code_hash: sha256Hex(code),
      client_id: CLIENT_ID,
      user_id: USER_ID,
      redirect_uri: REDIRECT,
      scopes: ["read", "write"],
      code_challenge: request.codeChallenge,
      resource: RESOURCE,
      expires_at: new Date(T0.getTime() + 5 * MINUTE).toISOString(),
    });
    expect(fake.tables.oauth_codes[0].used_at ?? null).toBeNull();
    expect(JSON.stringify(fake.tables)).not.toContain(code);
  });

  it("approves the blob the consent page rendered", async () => {
    const html = await renderConsent(authorizeQuery());
    const res = await decide(consentField(html)!, "approve");
    expect(res.status).toBe(303);
    expect(locationOf(res).searchParams.get("code")).toEqual(expect.any(String));
  });

  it("on deny, 303s back with access_denied and state, and stores nothing", async () => {
    const res = await decide(sealConsent(validRequest(), USER_ID), "deny");
    expect(res.status).toBe(303);
    const target = locationOf(res);
    expect(target.searchParams.get("error")).toBe("access_denied");
    expect(target.searchParams.get("state")).toBe("st-123");
    expect(target.searchParams.has("code")).toBe(false);
    expect(fake.tables.oauth_codes).toEqual([]);
  });

  it("leaves state out when the request had none, and keeps the redirect's own query", async () => {
    (fake.tables.oauth_clients[0].redirect_uris as string[]).push("https://claude.ai/cb?tenant=a");
    const request = validRequest({ state: null, redirectUri: "https://claude.ai/cb?tenant=a" });
    const res = await decide(sealConsent(request, USER_ID), "approve");
    const target = locationOf(res);
    expect(target.searchParams.get("tenant")).toBe("a");
    expect(target.searchParams.has("state")).toBe(false);
    expect(target.searchParams.has("code")).toBe(true);
  });

  it("rejects a tampered blob without redirecting", async () => {
    const blob = sealConsent(validRequest(), USER_ID);
    const [body, signature] = blob.split(".");
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    const widened = `${Buffer.from(JSON.stringify({ ...payload, scopes: ["read", "write"] })).toString("base64url")}.${signature}`;
    const res = await decide(widened, "approve");
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(fake.tables.oauth_codes).toEqual([]);
  });

  it("rejects an expired blob without redirecting", async () => {
    const blob = sealConsent(validRequest(), USER_ID);
    vi.setSystemTime(T0.getTime() + 11 * MINUTE);
    const res = await decide(blob, "approve");
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(fake.tables.oauth_codes).toEqual([]);
  });

  it("rejects a blob made for another user, and a signed-out browser", async () => {
    const theirs = sealConsent(validRequest(), OTHER_USER_ID);
    expect((await decide(theirs, "approve")).status).toBe(403);
    state.userId = null;
    expect((await decide(sealConsent(validRequest(), USER_ID), "approve")).status).toBe(403);
    expect(fake.tables.oauth_codes).toEqual([]);
  });

  it("rejects a cross-site post", async () => {
    const res = await decide(sealConsent(validRequest(), USER_ID), "approve", { Origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(fake.tables.oauth_codes).toEqual([]);
  });

  it("rejects a decision that is neither approve nor deny", async () => {
    expect((await decide(sealConsent(validRequest(), USER_ID), "maybe")).status).toBe(400);
  });

  it("re-checks the client: gone, or its redirect URI no longer registered", async () => {
    const blob = sealConsent(validRequest(), USER_ID);
    fake.tables.oauth_clients[0].redirect_uris = ["https://claude.ai/somewhere-else"];
    expect((await decide(blob, "approve")).status).toBe(400);
    fake.tables.oauth_clients = fake.tables.oauth_clients.filter((c) => c.client_id !== CLIENT_ID);
    expect((await decide(blob, "approve")).status).toBe(400);
    expect((await decide(sealConsent(validRequest({ clientId: OTHER_CLIENT_ID }), USER_ID), "approve")).status).toBe(400);
    expect(fake.tables.oauth_codes).toEqual([]);
  });

  it("refuses to issue a code for an account that is no longer allowed", async () => {
    fake.tables.users[0].is_allowed = false;
    expect((await decide(sealConsent(validRequest(), USER_ID), "approve")).status).toBe(403);
    expect(fake.tables.oauth_codes).toEqual([]);
  });
});
