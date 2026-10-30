import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./fake-db";
import type { FakeDb } from "./fake-db";
import { installPruneFunction, jsonPost } from "./oauth-fixtures";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase", () => ({ db: () => state.db }));

import { OPTIONS, POST } from "@/app/oauth/register/route";

// RFC 7591 dynamic client registration: public clients only, strict redirect
// URI rules, a sanitized display name, and a ceiling on how many may exist.

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-10-29T12:00:00.000Z");

let fake: FakeDb;

const register = (body: unknown) => POST(jsonPost("http://localhost:3000/oauth/register", body));
async function read(res: Response): Promise<{ status: number; json: Record<string, unknown> }> {
  return { status: res.status, json: await res.json() };
}
const clients = () => fake.tables.oauth_clients;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  fake = createFakeDb({ oauth_clients: [], oauth_codes: [], api_tokens: [] });
  installPruneFunction(fake);
  state.db = fake;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("POST /oauth/register", () => {
  it("answers 201 with the RFC 7591 shape and stores the client", async () => {
    const res = await register({
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "read write",
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { status, json } = await read(res);
    expect(status).toBe(201);
    expect(json).toEqual({
      client_id: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      client_id_issued_at: T0.getTime() / 1000,
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    expect(json).not.toHaveProperty("client_secret");
    expect(clients()).toHaveLength(1);
    expect(clients()[0]).toMatchObject({
      client_id: json.client_id,
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      token_endpoint_auth_method: "none",
      created_at: T0.toISOString(),
    });
  });

  it("defaults the name, grant types and response types, and gives each client its own id", async () => {
    const a = await read(await register({ redirect_uris: ["https://a.example/cb"] }));
    const b = await read(await register({ redirect_uris: ["https://a.example/cb"], client_name: null }));
    expect(a.status).toBe(201);
    expect(a.json).toMatchObject({
      client_name: "Unnamed client",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    expect(b.json.client_id).not.toBe(a.json.client_id);
  });

  it("echoes a narrower grant_types list", async () => {
    const { json } = await read(
      await register({ redirect_uris: ["https://a.example/cb"], grant_types: ["authorization_code"] })
    );
    expect(json.grant_types).toEqual(["authorization_code"]);
  });

  it.each([
    ["https anywhere", "https://chatgpt.com/connector_platform_oauth_redirect"],
    ["https with a query string", "https://a.example/cb?tenant=1"],
    ["http on localhost, any port", "http://localhost:6274/oauth/callback"],
    ["http on 127.0.0.1", "http://127.0.0.1:33418/callback"],
    ["http on [::1]", "http://[::1]:8080/callback"],
    ["http on localhost without a port", "http://localhost/callback"],
    ["a cursor:// app link", "cursor://anysphere.cursor-mcp/oauth/callback"],
    ["a vscode:// app link", "vscode://vscode.github-authentication/did-authenticate"],
    ["a reverse-domain scheme", "com.example.app:/oauth2redirect"],
  ])("accepts %s", async (_label, uri) => {
    const { status, json } = await read(await register({ redirect_uris: [uri] }));
    expect(status).toBe(201);
    expect(json.redirect_uris).toEqual([uri]);
  });

  it.each([
    ["http on a public host", "http://claude.ai/callback"],
    ["http on a host that only starts with localhost", "http://localhost.evil.example/callback"],
    ["http on another private address", "http://192.168.1.10/callback"],
    ["a javascript: URI", "javascript:alert(1)"],
    ["a data: URI", "data:text/html,hi"],
    ["a file: URI", "file:///etc/passwd"],
    ["a relative URI", "/callback"],
    ["a fragment", "https://a.example/cb#frag"],
    ["embedded credentials", "https://user:pass@a.example/cb"],
    ["a space", "https://a.example/c b"],
    ["an empty string", ""],
    ["a number", 42],
  ])("rejects %s with invalid_redirect_uri", async (_label, uri) => {
    const { status, json } = await read(await register({ redirect_uris: [uri] }));
    expect(status).toBe(400);
    expect(json).toEqual({ error: "invalid_redirect_uri", error_description: expect.any(String) });
    expect(clients()).toEqual([]);
  });

  it.each([
    ["no redirect_uris", {}],
    ["an empty list", { redirect_uris: [] }],
    ["a string instead of a list", { redirect_uris: "https://a.example/cb" }],
    ["eleven URIs", { redirect_uris: Array.from({ length: 11 }, (_, i) => `https://a.example/cb${i}`) }],
  ])("rejects %s", async (_label, body) => {
    const { status, json } = await read(await register(body));
    expect(status).toBe(400);
    expect(json.error).toBe("invalid_redirect_uri");
  });

  it("accepts ten URIs", async () => {
    const uris = Array.from({ length: 10 }, (_, i) => `https://a.example/cb${i}`);
    expect((await register({ redirect_uris: uris })).status).toBe(201);
  });

  it.each(["client_secret_basic", "client_secret_post", "private_key_jwt", ""])(
    "rejects token_endpoint_auth_method %j: public clients only",
    async (method) => {
      const { status, json } = await read(
        await register({ redirect_uris: ["https://a.example/cb"], token_endpoint_auth_method: method })
      );
      expect(status).toBe(400);
      expect(json.error).toBe("invalid_client_metadata");
      expect(json.error_description).toMatch(/"none"/);
      expect(clients()).toEqual([]);
    }
  );

  it.each([
    ["an unsupported grant type", { grant_types: ["client_credentials"] }],
    ["the implicit response type", { response_types: ["token"] }],
    ["a non-string name", { client_name: 7 }],
    ["a non-string scope", { scope: ["read"] }],
  ])("rejects %s with invalid_client_metadata", async (_label, extra) => {
    const { status, json } = await read(await register({ redirect_uris: ["https://a.example/cb"], ...extra }));
    expect(status).toBe(400);
    expect(json.error).toBe("invalid_client_metadata");
  });

  it.each([
    ["no body", ""],
    ["broken JSON", '{"redirect_uris": ['],
    ["an array", "[]"],
    ["null", "null"],
  ])("rejects %s", async (_label, body) => {
    const { status, json } = await read(await register(body));
    expect(status).toBe(400);
    expect(json.error).toBe("invalid_client_metadata");
  });

  it.each([
    ["trims it", "   Claude   ", "Claude"],
    ["turns control characters into spaces", "Evil\nClient\tName\u0007", "Evil Client Name"],
    ["drops bidi overrides and zero-width characters", "Good\u202Eemit\u200B App", "Goodemit App"],
    ["collapses runs of whitespace", "A     B", "A B"],
    ["caps it at 100 characters", "x".repeat(150), "x".repeat(100)],
    ["counts characters, not UTF-16 units", "🪦".repeat(120), "🪦".repeat(100)],
    ["falls back when nothing printable is left", "\u0000\u200B\n", "Unnamed client"],
  ])("sanitizes the name: %s", async (_label, name, expected) => {
    const { status, json } = await read(await register({ redirect_uris: ["https://a.example/cb"], client_name: name }));
    expect(status).toBe(201);
    expect(json.client_name).toBe(expected);
    expect(clients()[0].client_name).toBe(expected);
  });

  it("refuses a body over 64 KB from its Content-Length, before reading it", async () => {
    const req = jsonPost("http://localhost:3000/oauth/register", { redirect_uris: ["https://a.example/cb"] }, {
      "Content-Length": String(64 * 1024 + 1),
    });
    const text = vi.spyOn(req, "text");
    const res = await POST(req);
    const { status, json } = await read(res);
    expect(status).toBe(413);
    expect(json).toEqual({ error: "invalid_client_metadata", error_description: "The registration request is too large" });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(text).not.toHaveBeenCalled();
    expect(clients()).toEqual([]);
  });

  it("still measures a body sent without Content-Length", async () => {
    const big = { redirect_uris: ["https://a.example/cb"], client_name: "x".repeat(64 * 1024) };
    const { status, json } = await read(await register(big));
    expect(status).toBe(413);
    expect(json.error).toBe("invalid_client_metadata");
    expect(clients()).toEqual([]);
  });

  it("asks the database to prune with the hour and 30-day windows", async () => {
    const prune = vi.spyOn(fake.functions, "prune_oauth_clients");
    expect((await register({ redirect_uris: ["https://a.example/cb"] })).status).toBe(201);
    expect(prune).toHaveBeenCalledWith({ p_unused_minutes: 60, p_stale_days: 30 });
  });

  it("answers 500 with an OAuth error when the database fails", async () => {
    delete fake.functions.prune_oauth_clients;
    const { status, json } = await read(await register({ redirect_uris: ["https://a.example/cb"] }));
    expect(status).toBe(500);
    expect(json.error).toBe("server_error");
  });
});

// A flood of registrations must not lock real sign-ups out: what is never used
// goes within the hour, and at the ceiling the oldest client nobody is
// connected through makes room. 503 is left for a server with a thousand live
// connections.
describe("POST /oauth/register: pruning and eviction", () => {
  const MINUTE = 60 * 1000;
  const ago = (ms: number) => new Date(T0.getTime() - ms).toISOString();
  const addClient = (client_id: string, created_at: string) =>
    fake.tables.oauth_clients.push({ client_id, redirect_uris: ["https://a.example/cb"], created_at });
  const ids = () => clients().map((c) => c.client_id);
  /** 1,000 clients, c0 to c999, created a minute apart from 2,000 minutes ago (c0 oldest). */
  function fillToCeiling() {
    for (let i = 0; i < 1000; i++) addClient(`c${i}`, ago((2000 - i) * MINUTE));
  }
  const liveToken = (client_id: string, extra: Record<string, unknown> = {}) =>
    fake.tables.api_tokens.push({ id: `t-${client_id}`, client_id, revoked_at: null, expires_at: null, ...extra });

  it("prunes a client that never got a code or a token after 61 minutes, but not after 59", async () => {
    addClient("unused-61", ago(61 * MINUTE));
    addClient("unused-59", ago(59 * MINUTE));
    const { status, json } = await read(await register({ redirect_uris: ["https://a.example/cb"] }));
    expect(status).toBe(201);
    expect(ids()).toEqual(["unused-59", json.client_id]);
  });

  it("keeps a client that has a code or a token, however young or old", async () => {
    addClient("with-code", ago(61 * MINUTE));
    addClient("with-token", ago(61 * MINUTE));
    fake.tables.oauth_codes.push({ code_hash: "h", client_id: "with-code", expires_at: ago(-MINUTE) });
    liveToken("with-token");
    await register({ redirect_uris: ["https://a.example/cb"] });
    expect(ids()).toEqual(expect.arrayContaining(["with-code", "with-token"]));
  });

  it("prunes a client older than 30 days whose tokens are all revoked and whose codes expired", async () => {
    addClient("revoked-31d", ago(31 * DAY));
    addClient("revoked-29d", ago(29 * DAY));
    addClient("live-31d", ago(31 * DAY));
    addClient("pending-code-31d", ago(31 * DAY));
    liveToken("revoked-31d", { revoked_at: ago(DAY) });
    liveToken("revoked-29d", { revoked_at: ago(DAY) });
    liveToken("live-31d");
    liveToken("pending-code-31d", { revoked_at: ago(DAY) });
    fake.tables.oauth_codes.push(
      { code_hash: "old", client_id: "revoked-31d", expires_at: ago(DAY) },
      { code_hash: "pending", client_id: "pending-code-31d", expires_at: ago(-MINUTE) }
    );
    const { json } = await read(await register({ redirect_uris: ["https://a.example/cb"] }));
    expect(ids()).toEqual(["revoked-29d", "live-31d", "pending-code-31d", json.client_id]);
  });

  it("at the ceiling, evicts the oldest never-used client and registers", async () => {
    // A flood in progress: 1,000 never-used clients younger than an hour, so pruning frees nothing.
    fillToCeiling();
    for (const client of clients()) client.created_at = ago(30 * MINUTE);
    clients()[0].created_at = ago(59 * MINUTE); // c0 is the oldest
    const res = await register({ redirect_uris: ["https://a.example/cb"] });
    const { status, json } = await read(res);
    expect(status).toBe(201);
    expect(ids()).not.toContain("c0");
    expect(ids()).toContain(json.client_id);
    expect(clients()).toHaveLength(1000);
  });

  it("never evicts a client with a live token: it takes the oldest one without", async () => {
    fillToCeiling();
    // Pruning can't help: every client has a token; c0 and c1 are live, c2's expired, the rest revoked
    // but younger than 30 days.
    for (const client of clients()) {
      client.created_at = ago(DAY);
      liveToken(String(client.client_id), { revoked_at: ago(MINUTE) });
    }
    clients()[0].created_at = ago(3 * DAY);
    clients()[1].created_at = ago(3 * DAY);
    clients()[2].created_at = ago(2 * DAY);
    fake.tables.api_tokens[0].revoked_at = null;
    fake.tables.api_tokens[1].revoked_at = null;
    fake.tables.api_tokens[1].expires_at = ago(-DAY);
    fake.tables.api_tokens[2].revoked_at = null;
    fake.tables.api_tokens[2].expires_at = ago(MINUTE);

    expect((await register({ redirect_uris: ["https://a.example/cb"] })).status).toBe(201);
    expect(ids()).toEqual(expect.arrayContaining(["c0", "c1"]));
    expect(ids()).not.toContain("c2");
  });

  it("never evicts a client whose user is mid-way through connecting (an unused, unexpired code)", async () => {
    fillToCeiling();
    for (const client of clients()) client.created_at = ago(30 * MINUTE);
    clients()[0].created_at = ago(59 * MINUTE);
    fake.tables.oauth_codes.push({ code_hash: "h", client_id: "c0", used_at: null, expires_at: ago(-MINUTE) });
    expect((await register({ redirect_uris: ["https://a.example/cb"] })).status).toBe(201);
    expect(ids()).toContain("c0");
    expect(clients()).toHaveLength(1000);
  });

  it("answers 503 and stores nothing only when every client has a live token", async () => {
    fillToCeiling();
    for (const client of clients()) liveToken(String(client.client_id));
    const res = await register({ redirect_uris: ["https://a.example/cb"] });
    const { status, json } = await read(res);
    expect(status).toBe(503);
    expect(json).toEqual({ error: "temporarily_unavailable", error_description: expect.any(String) });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(clients()).toHaveLength(1000);
  });

  it("evicts a few at most, then registers anyway", async () => {
    // Over the ceiling (registrations raced): five evictions, then the new client goes in.
    for (let i = 0; i < 1010; i++) addClient(`c${i}`, ago((2000 - i) * MINUTE));
    for (const client of clients()) liveToken(String(client.client_id), { expires_at: ago(MINUTE) });
    const evict = vi.spyOn(fake.functions, "evict_oauth_client");
    expect((await register({ redirect_uris: ["https://a.example/cb"] })).status).toBe(201);
    expect(evict).toHaveBeenCalledTimes(5);
    expect(clients()).toHaveLength(1006);
  });

  it("answers 500 when eviction fails", async () => {
    fillToCeiling();
    for (const client of clients()) client.created_at = ago(30 * MINUTE);
    delete fake.functions.evict_oauth_client;
    const { status, json } = await read(await register({ redirect_uris: ["https://a.example/cb"] }));
    expect(status).toBe(500);
    expect(json.error).toBe("server_error");
  });
});

describe("OPTIONS /oauth/register", () => {
  it("allows a browser client to register cross-origin", () => {
    const res = OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
    expect(res.headers.get("access-control-allow-headers")).toMatch(/Content-Type/);
  });
});
