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

  it("prunes stale clients that never got a token or a code, keeping the rest", async () => {
    const old = new Date(T0.getTime() - 31 * DAY).toISOString();
    const recent = new Date(T0.getTime() - 29 * DAY).toISOString();
    fake.tables.oauth_clients.push(
      { client_id: "stale", redirect_uris: ["https://a.example/cb"], created_at: old },
      { client_id: "stale-with-token", redirect_uris: ["https://a.example/cb"], created_at: old },
      { client_id: "stale-with-code", redirect_uris: ["https://a.example/cb"], created_at: old },
      { client_id: "recent", redirect_uris: ["https://a.example/cb"], created_at: recent }
    );
    fake.tables.api_tokens.push({ id: "t1", client_id: "stale-with-token" });
    fake.tables.oauth_codes.push({ code_hash: "h", client_id: "stale-with-code" });

    const { status, json } = await read(await register({ redirect_uris: ["https://a.example/cb"] }));
    expect(status).toBe(201);
    expect(clients().map((c) => c.client_id)).toEqual(["stale-with-token", "stale-with-code", "recent", json.client_id]);
  });

  it("answers 503 and stores nothing once 1,000 clients exist", async () => {
    for (let i = 0; i < 1000; i++) {
      fake.tables.oauth_clients.push({ client_id: `c${i}`, redirect_uris: [], created_at: T0.toISOString() });
    }
    const res = await register({ redirect_uris: ["https://a.example/cb"] });
    const { status, json } = await read(res);
    expect(status).toBe(503);
    expect(json).toEqual({ error: "temporarily_unavailable", error_description: expect.any(String) });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(clients()).toHaveLength(1000);
  });

  it("registers again once pruning makes room", async () => {
    const old = new Date(T0.getTime() - 40 * DAY).toISOString();
    for (let i = 0; i < 1000; i++) {
      fake.tables.oauth_clients.push({ client_id: `c${i}`, redirect_uris: [], created_at: i === 0 ? old : T0.toISOString() });
    }
    expect((await register({ redirect_uris: ["https://a.example/cb"] })).status).toBe(201);
    expect(clients()).toHaveLength(1000);
  });

  it("answers 500 with an OAuth error when the database fails", async () => {
    delete fake.functions.prune_oauth_clients;
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
