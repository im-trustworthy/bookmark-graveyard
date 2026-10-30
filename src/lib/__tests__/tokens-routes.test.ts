import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createFakeDb } from "./fake-db";
import type { FakeDb } from "./fake-db";

const state = vi.hoisted(() => ({ db: null as unknown, userId: "u1" as string | null }));
vi.mock("@/lib/session", () => ({ getSessionUserId: async () => state.userId }));
vi.mock("@/lib/supabase", () => ({ db: () => state.db }));

import { GET as listRoute, POST as createRoute } from "@/app/api/tokens/route";
import { DELETE as revokeRoute } from "@/app/api/tokens/[id]/route";
import { mintApiToken, verifyApiToken } from "@/lib/api-tokens";

const RECORD_KEYS = [
  "client_id",
  "created_at",
  "expires_at",
  "id",
  "last_used_at",
  "name",
  "prefix",
  "revoked_at",
  "scopes",
].sort();

let fake: FakeDb;

const create = (body: unknown, headers: Record<string, string> = {}) =>
  createRoute(
    new NextRequest("http://localhost/api/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  );
const revoke = (id: string, headers: Record<string, string> = {}) =>
  revokeRoute(new NextRequest(`http://localhost/api/tokens/${id}`, { method: "DELETE", headers }), {
    params: Promise.resolve({ id }),
  });
async function read(res: Response): Promise<{ status: number; json: Record<string, unknown> }> {
  return { status: res.status, json: await res.json() };
}
const rowFor = (id: string) => fake.tables.api_tokens.find((r) => r.id === id) as Record<string, unknown>;

beforeEach(() => {
  fake = createFakeDb({
    users: [
      { id: "u1", is_allowed: true },
      { id: "u2", is_allowed: true },
    ],
    api_tokens: [],
  });
  state.db = fake;
  state.userId = "u1";
  vi.spyOn(console, "error").mockImplementation(() => {}); // apiError logs every rejection
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/tokens", () => {
  it("answers 201 with the plaintext once and the record, which has no hash", async () => {
    const res = await create({ name: "  Grok  ", scope: "write", expiresInDays: 90 });
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { status, json } = await read(res);
    expect(status).toBe(201);
    expect(Object.keys(json).sort()).toEqual(["record", "token"]);

    const token = json.token as string;
    const record = json.record as Record<string, unknown>;
    expect(token).toMatch(/^bg_[A-Za-z0-9_-]{43}$/);
    expect(Object.keys(record).sort()).toEqual(RECORD_KEYS);
    expect(record).toMatchObject({
      name: "Grok",
      prefix: token.slice(0, 8),
      scopes: ["read", "write"],
      client_id: null,
      last_used_at: null,
      revoked_at: null,
    });
    expect(Date.parse(record.expires_at as string) - Date.parse(record.created_at as string)).toBe(
      90 * 24 * 60 * 60 * 1000
    );

    const row = rowFor(record.id as string);
    expect(row.user_id).toBe("u1");
    expect(row.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(await verifyApiToken(token)).toMatchObject({ userId: "u1", scopes: ["read", "write"] });
  });

  it("makes read-only tokens with no expiry by default", async () => {
    for (const body of [
      { name: "a", scope: "read" },
      { name: "b", scope: "read", expiresInDays: null },
    ]) {
      const { status, json } = await read(await create(body));
      expect(status).toBe(201);
      expect(json.record).toMatchObject({ scopes: ["read"], expires_at: null });
    }
  });

  it.each([
    ["no body", ""],
    ["a non-object", "null"],
    ["an array", "[]"],
    ["broken JSON", '{"name": "Grok"'],
  ])("rejects %s", async (_label, body) => {
    const { status, json } = await read(await create(body));
    expect(status).toBe(400);
    expect(json.error).toMatch(/^Expected a JSON body/);
    expect(fake.tables.api_tokens).toEqual([]);
  });

  it.each([
    ["a missing name", { scope: "read" }, /^name must be 1 to 60 characters/],
    ["a non-string name", { name: 7, scope: "read" }, /^name must be 1 to 60 characters/],
    ["an empty name", { name: "", scope: "read" }, /^name must be 1 to 60 characters/],
    ["a blank name", { name: "    ", scope: "read" }, /^name must be 1 to 60 characters/],
    ["a 61-character name", { name: "x".repeat(61), scope: "read" }, /^name must be 1 to 60 characters/],
    ["a name with a newline", { name: "Gr\nok", scope: "read" }, /^name can't contain control characters/],
    ["a missing scope", { name: "Grok" }, /^scope must be "read" or "write"/],
    ["an unknown scope", { name: "Grok", scope: "admin" }, /^scope must be "read" or "write"/],
    ["a scope in the wrong case", { name: "Grok", scope: "READ" }, /^scope must be "read" or "write"/],
    ["a scope list", { name: "Grok", scope: ["read", "write"] }, /^scope must be "read" or "write"/],
    ["another expiry", { name: "Grok", scope: "read", expiresInDays: 30 }, /^expiresInDays must be 90 or null/],
    ["an expiry as a string", { name: "Grok", scope: "read", expiresInDays: "90" }, /^expiresInDays must be 90/],
  ])("rejects %s", async (_label, body, message) => {
    const { status, json } = await read(await create(body));
    expect(status).toBe(400);
    expect(json.error).toMatch(message);
    expect(fake.tables.api_tokens).toEqual([]);
  });

  it("accepts a 60-character name, trimmed", async () => {
    const name = "y".repeat(60);
    const { status, json } = await read(await create({ name: `  ${name} `, scope: "read" }));
    expect(status).toBe(201);
    expect((json.record as Record<string, unknown>).name).toBe(name);
  });

  it("caps a user at 25 live tokens; revoked, expired and other people's don't count", async () => {
    for (let i = 0; i < 24; i++) await mintApiToken("u1", { name: `t${i}`, scopes: ["read"] });
    const revoked = await mintApiToken("u1", { name: "revoked", scopes: ["read"] });
    rowFor(revoked.record.id).revoked_at = new Date().toISOString();
    const expired = await mintApiToken("u1", { name: "expired", scopes: ["read"] });
    rowFor(expired.record.id).expires_at = new Date(Date.now() - 1000).toISOString();
    for (let i = 0; i < 25; i++) await mintApiToken("u2", { name: `theirs${i}`, scopes: ["read"] });

    expect((await create({ name: "25th", scope: "read" })).status).toBe(201);

    const { status, json } = await read(await create({ name: "26th", scope: "read" }));
    expect(status).toBe(400);
    expect(json.error).toMatch(/^You already have 25 active tokens/);
    expect(fake.tables.api_tokens.filter((r) => r.user_id === "u1")).toHaveLength(27);
  });
});

describe("GET /api/tokens", () => {
  it("lists the caller's tokens, revoked ones flagged, with no hashes or owner ids", async () => {
    const mine = await mintApiToken("u1", { name: "Grok", scopes: ["read"] });
    const old = await mintApiToken("u1", { name: "Old", scopes: ["write"] });
    await mintApiToken("u2", { name: "Theirs", scopes: ["read"] });
    expect((await revoke(old.record.id)).status).toBe(200);

    const { status, json } = await read(await listRoute());
    expect(status).toBe(200);
    const tokens = json.tokens as Record<string, unknown>[];
    expect(tokens.map((t) => t.id).sort()).toEqual([mine.record.id, old.record.id].sort());
    for (const t of tokens) expect(Object.keys(t).sort()).toEqual(RECORD_KEYS);
    expect(JSON.stringify(json)).not.toContain(rowFor(mine.record.id).token_hash as string);
    expect(tokens.find((t) => t.id === old.record.id)?.revoked_at).toEqual(expect.any(String));
  });

  it("is an empty list for someone with no tokens", async () => {
    expect(await read(await listRoute())).toEqual({ status: 200, json: { tokens: [] } });
  });
});

describe("DELETE /api/tokens/[id]", () => {
  it("revokes the caller's own token, which stops working at once", async () => {
    const { token, record } = await mintApiToken("u1", { name: "Grok", scopes: ["read"] });
    expect(await read(await revoke(record.id))).toEqual({ status: 200, json: { revoked: true } });
    expect(rowFor(record.id).revoked_at).toEqual(expect.any(String));
    expect(await verifyApiToken(token)).toBeNull();
  });

  it("is a 404 for another user's token, which keeps working", async () => {
    const theirs = await mintApiToken("u2", { name: "Theirs", scopes: ["read"] });
    const { status, json } = await read(await revoke(theirs.record.id));
    expect(status).toBe(404);
    expect(json.error).toMatch(/^Token not found/);
    expect(rowFor(theirs.record.id).revoked_at).toBeUndefined();
    expect(await verifyApiToken(theirs.token)).not.toBeNull();
  });

  it("is a 404 for an already revoked token, an unknown id and a malformed one", async () => {
    const { record } = await mintApiToken("u1", { name: "Grok", scopes: ["read"] });
    await revoke(record.id);
    const fromSpy = vi.spyOn(fake, "from");
    expect((await revoke(record.id)).status).toBe(404);
    expect((await revoke("00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect(fromSpy).toHaveBeenCalledTimes(2);
    expect((await revoke("not-a-uuid")).status).toBe(404);
    expect((await revoke("' or 1=1 --")).status).toBe(404);
    expect(fromSpy).toHaveBeenCalledTimes(2); // malformed ids never reach the database
  });
});

describe("session cookie only", () => {
  it("answers 401 to a valid bearer token without a session, and changes nothing", async () => {
    const { token, record } = await mintApiToken("u1", { name: "Grok", scopes: ["write"] });
    state.userId = null;
    const auth = { Authorization: `Bearer ${token}` };
    const before = structuredClone(fake.tables);

    const responses = [
      await listRoute(),
      await create({ name: "minted by a token", scope: "write" }, auth),
      await revoke(record.id, auth),
    ];
    expect(responses.map((res) => res.status)).toEqual([401, 401, 401]);
    for (const res of responses) expect((await res.json()).error).toMatch(/^Not logged in/);
    expect(fake.tables).toEqual(before);
  });
});
