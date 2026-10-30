import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createFakeDb } from "./fake-db";
import type { FakeDb } from "./fake-db";
import {
  APP,
  CLIENT_ID,
  formPost,
  jsonPost,
  OTHER_CLIENT_ID,
  oauthTables,
  pkcePair,
  REDIRECT,
  RESOURCE,
  sha256Hex,
  USER_ID,
} from "./oauth-fixtures";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase", () => ({ db: () => state.db }));

import { OPTIONS, POST } from "@/app/oauth/token/route";
import { verifyApiToken } from "@/lib/api-tokens";
import type { ApiScope } from "@/lib/api-tokens";
import { issueAuthorizationCode } from "@/lib/oauth";

// The token endpoint: code + PKCE verifier → an api_tokens row the existing
// bearer check accepts, and refresh-token rotation on that same row.

const T0 = new Date("2026-10-29T12:00:00.000Z");
const MINUTE = 60 * 1000;
const DAY = 24 * MINUTE * 60;
const URL_ = `${APP}/oauth/token`;

let fake: FakeDb;

const token = (fields: Record<string, string>) => POST(formPost(URL_, fields));
async function read(res: Response): Promise<{ status: number; json: Record<string, unknown> }> {
  return { status: res.status, json: await res.json() };
}
const tokens = () => fake.tables.api_tokens;

/** A stored code for the seeded client, as /api/oauth/decision would make it. */
async function newCode(opts: { scopes?: ApiScope[]; clientId?: string; redirectUri?: string } = {}) {
  const { verifier, challenge } = pkcePair();
  const code = await issueAuthorizationCode({
    clientId: opts.clientId ?? CLIENT_ID,
    redirectUri: opts.redirectUri ?? REDIRECT,
    scopes: opts.scopes ?? ["read"],
    state: "st",
    codeChallenge: challenge,
    resource: RESOURCE,
    userId: USER_ID,
    expiresAt: Date.now() + 10 * MINUTE,
  });
  return { code, verifier };
}

function exchangeFields(code: string, verifier: string, extra: Record<string, string> = {}) {
  return {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: CLIENT_ID,
    code_verifier: verifier,
    resource: RESOURCE,
    ...extra,
  };
}

/** A completed exchange: the token response body. */
async function connect(scopes: ApiScope[] = ["read"]) {
  const { code, verifier } = await newCode({ scopes });
  const { status, json } = await read(await token(exchangeFields(code, verifier)));
  expect(status).toBe(200);
  return json as { access_token: string; refresh_token: string; scope: string };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  fake = createFakeDb(oauthTables());
  state.db = fake;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("grant_type=authorization_code", () => {
  it("issues a 30-day api_tokens row tagged with the client, with a hashed refresh token", async () => {
    const { code, verifier } = await newCode({ scopes: ["read", "write"] });
    const res = await token(exchangeFields(code, verifier));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("pragma")).toBe("no-cache");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const { status, json } = await read(res);
    expect(status).toBe(200);
    expect(json).toEqual({
      access_token: expect.stringMatching(/^bg_[A-Za-z0-9_-]{43}$/),
      token_type: "Bearer",
      expires_in: 2592000,
      refresh_token: expect.stringMatching(/^bgr_[A-Za-z0-9_-]{43}$/),
      scope: "read write",
    });

    expect(tokens()).toHaveLength(1);
    expect(tokens()[0]).toMatchObject({
      user_id: USER_ID,
      name: "Claude",
      client_id: CLIENT_ID,
      scopes: ["read", "write"],
      token_hash: sha256Hex(json.access_token as string),
      refresh_token_hash: sha256Hex(json.refresh_token as string),
      expires_at: new Date(T0.getTime() + 30 * DAY).toISOString(),
    });
    expect(JSON.stringify(fake.tables)).not.toContain((json.access_token as string).slice(8));
    expect(JSON.stringify(fake.tables)).not.toContain(json.refresh_token as string);

    // The ordinary bearer check accepts it; the refresh token is never a bearer token.
    expect(await verifyApiToken(json.access_token as string)).toMatchObject({ userId: USER_ID, scopes: ["read", "write"] });
    expect(await verifyApiToken(json.refresh_token as string)).toBeNull();

    // Single use, and the client's last use is recorded.
    expect(fake.tables.oauth_codes[0].used_at).toBe(T0.toISOString());
    expect(fake.tables.oauth_clients[0].last_used_at).toBe(T0.toISOString());
  });

  it("answers read-only scope as \"read\"", async () => {
    expect((await connect(["read"])).scope).toBe("read");
  });

  it("parses a JSON body too", async () => {
    const { code, verifier } = await newCode();
    const { status, json } = await read(await POST(jsonPost(URL_, exchangeFields(code, verifier))));
    expect(status).toBe(200);
    expect(json.token_type).toBe("Bearer");
  });

  it("accepts the request without resource, or with a trailing slash on it", async () => {
    const a = await newCode();
    const fields = exchangeFields(a.code, a.verifier);
    delete (fields as Record<string, string>).resource;
    expect((await token(fields)).status).toBe(200);
    const b = await newCode();
    expect((await token(exchangeFields(b.code, b.verifier, { resource: `${RESOURCE}/` }))).status).toBe(200);
  });

  it("rejects a wrong verifier with invalid_grant, leaving the code usable", async () => {
    const { code, verifier } = await newCode();
    const wrong = pkcePair().verifier;
    const { status, json } = await read(await token(exchangeFields(code, wrong)));
    expect(status).toBe(400);
    expect(json.error).toBe("invalid_grant");
    expect(tokens()).toEqual([]);
    expect((await token(exchangeFields(code, verifier))).status).toBe(200);
  });

  it("rejects a replayed code with invalid_grant and revokes the token it produced", async () => {
    const { code, verifier } = await newCode();
    const first = await read(await token(exchangeFields(code, verifier)));
    expect(first.status).toBe(200);
    const accessToken = first.json.access_token as string;
    expect(fake.tables.oauth_codes[0].token_id).toBe(tokens()[0].id);
    expect(await verifyApiToken(accessToken)).not.toBeNull();

    vi.setSystemTime(T0.getTime() + MINUTE);
    const errorSpy = vi.mocked(console.error);
    errorSpy.mockClear();
    const { status, json } = await read(await token(exchangeFields(code, verifier)));
    expect(status).toBe(400);
    expect(json.error).toBe("invalid_grant");
    expect(tokens()).toHaveLength(1);
    expect(tokens()[0].revoked_at).toBe(new Date(T0.getTime() + MINUTE).toISOString());
    expect(await verifyApiToken(accessToken)).toBeNull();

    // One log line, naming the token, never the code or verifier.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = errorSpy.mock.calls[0].map(String).join(" ");
    expect(logged).toContain(String(tokens()[0].id));
    expect(logged).not.toContain(code);
    expect(logged).not.toContain(verifier);
  });

  it("revokes on replay even when the replay is otherwise wrong, and keeps the first revocation time", async () => {
    const { code, verifier } = await newCode();
    const first = await read(await token(exchangeFields(code, verifier)));
    await token(exchangeFields(code, pkcePair().verifier, { client_id: OTHER_CLIENT_ID }));
    const revokedAt = tokens()[0].revoked_at;
    expect(revokedAt).toBe(T0.toISOString());
    expect(await verifyApiToken(first.json.access_token as string)).toBeNull();

    vi.setSystemTime(T0.getTime() + MINUTE);
    expect((await read(await token(exchangeFields(code, verifier)))).json.error).toBe("invalid_grant");
    expect(tokens()[0].revoked_at).toBe(revokedAt);
  });

  it("lets only one of two concurrent exchanges of the same code win", async () => {
    const { code, verifier } = await newCode();
    const results = await Promise.all([token(exchangeFields(code, verifier)), token(exchangeFields(code, verifier))]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(tokens()).toHaveLength(1);
  });

  it("rejects an expired code with invalid_grant", async () => {
    const { code, verifier } = await newCode();
    vi.setSystemTime(T0.getTime() + 5 * MINUTE);
    const { status, json } = await read(await token(exchangeFields(code, verifier)));
    expect(status).toBe(400);
    expect(json.error).toBe("invalid_grant");
    expect(tokens()).toEqual([]);
  });

  it("accepts a code just before it expires", async () => {
    const { code, verifier } = await newCode();
    vi.setSystemTime(T0.getTime() + 5 * MINUTE - 1000);
    expect((await token(exchangeFields(code, verifier))).status).toBe(200);
  });

  it("rejects a code presented by another client with invalid_grant", async () => {
    const { code, verifier } = await newCode();
    const { status, json } = await read(await token(exchangeFields(code, verifier, { client_id: OTHER_CLIENT_ID })));
    expect(status).toBe(400);
    expect(json.error).toBe("invalid_grant");
    expect(tokens()).toEqual([]);
  });

  it("rejects a different redirect_uri with invalid_grant", async () => {
    const { code, verifier } = await newCode();
    const { status, json } = await read(
      await token(exchangeFields(code, verifier, { redirect_uri: "http://localhost:6274/oauth/callback" }))
    );
    expect(status).toBe(400);
    expect(json.error).toBe("invalid_grant");
  });

  it("rejects an unknown code with invalid_grant", async () => {
    const { status, json } = await read(await token(exchangeFields("x".repeat(43), pkcePair().verifier)));
    expect(status).toBe(400);
    expect(json.error).toBe("invalid_grant");
  });

  it("rejects an unknown client with invalid_client (401)", async () => {
    const { code, verifier } = await newCode();
    const { status, json } = await read(await token(exchangeFields(code, verifier, { client_id: "z".repeat(43) })));
    expect(status).toBe(401);
    expect(json.error).toBe("invalid_client");
  });

  it("rejects another resource with invalid_target", async () => {
    const { code, verifier } = await newCode();
    const { status, json } = await read(
      await token(exchangeFields(code, verifier, { resource: "https://evil.example/api/mcp" }))
    );
    expect(status).toBe(400);
    expect(json.error).toBe("invalid_target");
    expect(fake.tables.oauth_codes[0].used_at ?? null).toBeNull();
  });

  it.each(["code", "redirect_uri", "client_id", "code_verifier"])("requires %s", async (name) => {
    const { code, verifier } = await newCode();
    const fields: Record<string, string> = exchangeFields(code, verifier);
    delete fields[name];
    const { status, json } = await read(await token(fields));
    expect(status).toBe(400);
    expect(json.error).toBe("invalid_request");
  });

  it.each([
    ["too short", "a".repeat(42)],
    ["too long", "a".repeat(129)],
    ["a bad character", `${"a".repeat(42)}+`],
  ])("rejects a code_verifier that is %s with invalid_request", async (_label, verifier) => {
    const { code } = await newCode();
    const { json } = await read(await token(exchangeFields(code, verifier)));
    expect(json.error).toBe("invalid_request");
  });

  it("refuses a user who was taken off the allowlist", async () => {
    const { code, verifier } = await newCode();
    fake.tables.users[0].is_allowed = false;
    const { status, json } = await read(await token(exchangeFields(code, verifier)));
    expect(status).toBe(400);
    expect(json.error).toBe("invalid_grant");
    expect(tokens()).toEqual([]);
  });

  it("keeps one connection per client per user: a fresh exchange revokes the client's earlier tokens", async () => {
    const first = await connect(["read", "write"]);
    // Another client's connection and a dashboard token for the same user, and this client for another user.
    fake.tables.api_tokens.push(
      { id: "other-client", user_id: USER_ID, client_id: OTHER_CLIENT_ID, revoked_at: null, expires_at: null },
      { id: "dashboard", user_id: USER_ID, client_id: null, revoked_at: null, expires_at: null },
      { id: "other-user", user_id: "someone-else", client_id: CLIENT_ID, revoked_at: null, expires_at: null }
    );
    vi.setSystemTime(T0.getTime() + MINUTE);
    const second = await connect(["read"]);

    expect(await verifyApiToken(first.access_token)).toBeNull();
    expect(await verifyApiToken(second.access_token)).toMatchObject({ userId: USER_ID, scopes: ["read"] });
    const byId = (id: string) => tokens().find((t) => t.id === id)!;
    expect(tokens()[0].revoked_at).toBe(new Date(T0.getTime() + MINUTE).toISOString());
    for (const id of ["other-client", "dashboard", "other-user"]) expect(byId(id).revoked_at).toBeNull();
    // The first connection's refresh token died with it.
    const refreshed = await read(
      await token({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: CLIENT_ID })
    );
    expect(refreshed.json.error).toBe("invalid_grant");
  });

  it("refuses to mint past the account's 25 active tokens, counting after its own old tokens are revoked", async () => {
    const live = (i: number, extra: Record<string, unknown> = {}) => ({
      id: `live-${i}`,
      user_id: USER_ID,
      client_id: null,
      revoked_at: null,
      expires_at: null,
      ...extra,
    });
    // 25 live tokens elsewhere (an expired and a revoked one don't count): the cap is reached.
    fake.tables.api_tokens.push(
      ...Array.from({ length: 25 }, (_, i) => live(i)),
      live(98, { expires_at: new Date(T0.getTime() - MINUTE).toISOString() }),
      live(99, { revoked_at: T0.toISOString() })
    );
    const { code, verifier } = await newCode();
    const { status, json } = await read(await token(exchangeFields(code, verifier)));
    expect(status).toBe(400);
    expect(json).toEqual({
      error: "invalid_grant",
      error_description: "This account already has the maximum number of active tokens; revoke one in the Assistants panel",
    });
    expect(tokens().filter((t) => t.client_id === CLIENT_ID)).toEqual([]);

    // 24 elsewhere plus this client's own earlier token: that one is revoked first, so there is room.
    tokens().find((t) => t.id === "live-0")!.client_id = CLIENT_ID;
    const again = await newCode();
    expect((await token(exchangeFields(again.code, again.verifier))).status).toBe(200);
    expect(tokens().find((t) => t.id === "live-0")!.revoked_at).toBe(T0.toISOString());
  });

  it("prunes codes that expired more than a day ago", async () => {
    fake.tables.oauth_codes.push(
      { code_hash: "old", client_id: CLIENT_ID, expires_at: new Date(T0.getTime() - DAY - 1).toISOString() },
      { code_hash: "recent", client_id: CLIENT_ID, expires_at: new Date(T0.getTime() - DAY + MINUTE).toISOString() }
    );
    await connect();
    expect(fake.tables.oauth_codes.map((c) => c.code_hash)).toEqual(expect.arrayContaining(["recent"]));
    expect(fake.tables.oauth_codes.map((c) => c.code_hash)).not.toContain("old");
  });

  it("never logs or echoes the code or verifier when the database fails", async () => {
    const { code, verifier } = await newCode();
    const errorSpy = vi.mocked(console.error);
    const realFrom = fake.from.bind(fake);
    vi.spyOn(fake, "from").mockImplementation((table) =>
      table === "api_tokens"
        ? Object.assign(realFrom(table), {
            single: () => Promise.resolve({ data: null, error: { message: "connection refused" } }),
          })
        : realFrom(table)
    );
    const res = await token(exchangeFields(code, verifier));
    const body = await res.text();
    expect(res.status).toBe(500);
    expect(JSON.parse(body).error).toBe("server_error");
    const logged = JSON.stringify(errorSpy.mock.calls.map((call) => call.map(String)));
    for (const secret of [code, verifier]) {
      expect(body).not.toContain(secret);
      expect(logged).not.toContain(secret);
    }
  });
});

describe("grant_type=refresh_token", () => {
  const refreshFields = (refreshToken: string, extra: Record<string, string> = {}) => ({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    ...extra,
  });

  it("rotates both tokens on the same row; the old pair stops working", async () => {
    const first = await connect(["read", "write"]);
    vi.setSystemTime(T0.getTime() + 20 * DAY);
    const { status, json } = await read(await token(refreshFields(first.refresh_token)));
    expect(status).toBe(200);
    expect(json).toEqual({
      access_token: expect.stringMatching(/^bg_/),
      token_type: "Bearer",
      expires_in: 2592000,
      refresh_token: expect.stringMatching(/^bgr_/),
      scope: "read write",
    });
    expect(json.access_token).not.toBe(first.access_token);
    expect(json.refresh_token).not.toBe(first.refresh_token);

    expect(tokens()).toHaveLength(1); // one entry per connected client
    expect(tokens()[0]).toMatchObject({
      token_hash: sha256Hex(json.access_token as string),
      refresh_token_hash: sha256Hex(json.refresh_token as string),
      prefix: (json.access_token as string).slice(0, 8),
      scopes: ["read", "write"],
      expires_at: new Date(T0.getTime() + 50 * DAY).toISOString(),
      last_used_at: new Date(T0.getTime() + 20 * DAY).toISOString(),
    });

    expect(await verifyApiToken(first.access_token)).toBeNull();
    expect(await verifyApiToken(json.access_token as string)).toMatchObject({ userId: USER_ID });
    const replay = await read(await token(refreshFields(first.refresh_token)));
    expect(replay.status).toBe(400);
    expect(replay.json.error).toBe("invalid_grant");
  });

  it("treats a rotated-away refresh token presented again as stolen: the row is revoked", async () => {
    const first = await connect(["read", "write"]);
    vi.setSystemTime(T0.getTime() + DAY);
    const second = (await read(await token(refreshFields(first.refresh_token)))).json as typeof first;
    expect(tokens()[0].previous_refresh_token_hash).toBe(sha256Hex(first.refresh_token));
    expect(await verifyApiToken(second.access_token)).not.toBeNull();

    const errorSpy = vi.mocked(console.error);
    errorSpy.mockClear();
    vi.setSystemTime(T0.getTime() + DAY + MINUTE);
    const reuse = await read(await token(refreshFields(first.refresh_token)));
    expect(reuse.status).toBe(400);
    expect(reuse.json.error).toBe("invalid_grant");
    expect(tokens()[0].revoked_at).toBe(new Date(T0.getTime() + DAY + MINUTE).toISOString());

    // Everything issued after the stolen token dies with it.
    expect(await verifyApiToken(second.access_token)).toBeNull();
    expect((await read(await token(refreshFields(second.refresh_token)))).json.error).toBe("invalid_grant");

    // One log line, naming the token id, never a token.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = errorSpy.mock.calls[0].map(String).join(" ");
    expect(logged).toContain(String(tokens()[0].id));
    for (const secret of [first.refresh_token, second.refresh_token, second.access_token]) {
      expect(logged).not.toContain(secret);
    }
  });

  it("revokes on reuse even when the replay names another client, and keeps the first revocation time", async () => {
    const first = await connect();
    await token(refreshFields(first.refresh_token));
    await token(refreshFields(first.refresh_token, { client_id: OTHER_CLIENT_ID }));
    expect(tokens()[0].revoked_at).toBe(T0.toISOString());
    vi.setSystemTime(T0.getTime() + MINUTE);
    expect((await read(await token(refreshFields(first.refresh_token)))).json.error).toBe("invalid_grant");
    expect(tokens()[0].revoked_at).toBe(T0.toISOString());
  });

  it("refuses a refresh after 90 days without use: accepted at 89 days, refused at 91", async () => {
    const idle89 = await connect();
    vi.setSystemTime(T0.getTime() + 89 * DAY);
    expect((await token(refreshFields(idle89.refresh_token))).status).toBe(200);

    vi.setSystemTime(T0);
    fake = createFakeDb(oauthTables());
    state.db = fake;
    const idle91 = await connect();
    vi.setSystemTime(T0.getTime() + 91 * DAY);
    const { status, json } = await read(await token(refreshFields(idle91.refresh_token)));
    expect(status).toBe(400);
    expect(json).toEqual({ error: "invalid_grant", error_description: expect.stringMatching(/unused for 90 days/) });
    expect(tokens()[0].revoked_at ?? null).toBeNull();
  });

  it("counts API use as use: idle is measured from the last call, not from the last refresh", async () => {
    const first = await connect();
    vi.setSystemTime(T0.getTime() + 20 * DAY);
    expect(await verifyApiToken(first.access_token)).not.toBeNull(); // bumps last_used_at
    vi.setSystemTime(T0.getTime() + 105 * DAY);
    expect((await token(refreshFields(first.refresh_token))).status).toBe(200);
  });

  it("refreshes an access token that has already expired", async () => {
    const first = await connect();
    vi.setSystemTime(T0.getTime() + 45 * DAY);
    expect(await verifyApiToken(first.access_token)).toBeNull();
    expect((await token(refreshFields(first.refresh_token))).status).toBe(200);
  });

  it("allows narrowing write to read", async () => {
    const first = await connect(["read", "write"]);
    const { status, json } = await read(await token(refreshFields(first.refresh_token, { scope: "read" })));
    expect(status).toBe(200);
    expect(json.scope).toBe("read");
    expect(tokens()[0].scopes).toEqual(["read"]);
    expect(await verifyApiToken(json.access_token as string)).toMatchObject({ scopes: ["read"] });
  });

  it("rejects widening read to write with invalid_scope, changing nothing", async () => {
    const first = await connect(["read"]);
    const before = structuredClone(tokens()[0]);
    for (const scope of ["write", "read write", "admin"]) {
      const { status, json } = await read(await token(refreshFields(first.refresh_token, { scope })));
      expect(status).toBe(400);
      expect(json.error).toBe("invalid_scope");
    }
    expect(tokens()[0]).toEqual(before);
    expect((await token(refreshFields(first.refresh_token))).status).toBe(200);
  });

  it("rejects another client's refresh token with invalid_grant", async () => {
    const first = await connect();
    const { status, json } = await read(await token(refreshFields(first.refresh_token, { client_id: OTHER_CLIENT_ID })));
    expect(status).toBe(400);
    expect(json.error).toBe("invalid_grant");
  });

  it("rejects a refresh token whose row was revoked in the Assistants panel", async () => {
    const first = await connect();
    tokens()[0].revoked_at = T0.toISOString();
    const { status, json } = await read(await token(refreshFields(first.refresh_token)));
    expect(status).toBe(400);
    expect(json.error).toBe("invalid_grant");
  });

  it("rejects an access token presented as a refresh token, and garbage", async () => {
    const first = await connect();
    for (const bad of [first.access_token, `bgr_${"A".repeat(43)}`, "nope"]) {
      const { json } = await read(await token(refreshFields(bad)));
      expect(json.error).toBe("invalid_grant");
    }
  });

  it("refuses a user who was taken off the allowlist", async () => {
    const first = await connect();
    fake.tables.users[0].is_allowed = false;
    expect((await read(await token(refreshFields(first.refresh_token)))).json.error).toBe("invalid_grant");
  });

  it("lets only one of two concurrent refreshes with the same token win", async () => {
    const first = await connect();
    const results = await Promise.all([token(refreshFields(first.refresh_token)), token(refreshFields(first.refresh_token))]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
  });

  it("parses a JSON body too", async () => {
    const first = await connect();
    expect((await POST(jsonPost(URL_, refreshFields(first.refresh_token)))).status).toBe(200);
  });

  it.each(["refresh_token", "client_id"])("requires %s", async (name) => {
    const first = await connect();
    const fields: Record<string, string> = refreshFields(first.refresh_token);
    delete fields[name];
    expect((await read(await token(fields))).json.error).toBe("invalid_request");
  });
});

describe("the request itself", () => {
  it.each([
    ["no grant_type", {}, "invalid_request"],
    ["the client_credentials grant", { grant_type: "client_credentials" }, "unsupported_grant_type"],
    ["the password grant", { grant_type: "password" }, "unsupported_grant_type"],
  ])("rejects %s", async (_label, fields, error) => {
    const { status, json } = await read(await token(fields as Record<string, string>));
    expect(status).toBe(400);
    expect(json).toEqual({ error, error_description: expect.any(String) });
  });

  it("rejects a repeated parameter", async () => {
    const res = await POST(
      new NextRequest(URL_, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=authorization_code&code=a&code=b",
      })
    );
    const { status, json } = await read(res);
    expect(status).toBe(400);
    expect(json.error).toBe("invalid_request");
    expect(json.error_description).toMatch(/^code /);
  });

  it("reads a form body sent without a content type", async () => {
    const { code, verifier } = await newCode();
    const res = await POST(
      new NextRequest(URL_, { method: "POST", body: new URLSearchParams(exchangeFields(code, verifier)).toString() })
    );
    expect(res.status).toBe(200);
  });

  it.each([
    ["broken JSON", "{"],
    ["a JSON array", "[]"],
    ["a JSON value that isn't a string", JSON.stringify({ grant_type: "refresh_token", refresh_token: 5 })],
  ])("rejects %s", async (_label, body) => {
    const { status, json } = await read(await POST(jsonPost(URL_, body)));
    expect(status).toBe(400);
    expect(json.error).toBe("invalid_request");
  });

  it("refuses a body over 64 KB from its Content-Length, before reading it", async () => {
    const req = formPost(URL_, { grant_type: "refresh_token" }, { "Content-Length": String(64 * 1024 + 1) });
    const text = vi.spyOn(req, "text");
    const res = await POST(req);
    expect(res.status).toBe(413);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toEqual({ error: "invalid_request", error_description: "The request body is too large" });
    expect(text).not.toHaveBeenCalled();
  });

  it("still measures a body sent without Content-Length", async () => {
    const res = await POST(formPost(URL_, { grant_type: "refresh_token", padding: "x".repeat(64 * 1024) }));
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe("invalid_request");
  });

  it("answers a CORS preflight", () => {
    const res = OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
  });
});
