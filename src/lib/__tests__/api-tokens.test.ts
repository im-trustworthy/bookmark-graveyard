import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./fake-db";
import type { FakeDb } from "./fake-db";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase", () => ({ db: () => state.db }));

import {
  countActiveApiTokens,
  findRefreshGrant,
  hasScope,
  LAST_USED_THROTTLE_MS,
  listApiTokens,
  mintApiToken,
  mintOAuthToken,
  revokeApiToken,
  rotateOAuthToken,
  verifyApiToken,
} from "@/lib/api-tokens";

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-10-29T12:00:00.000Z");

let fake: FakeDb;
const rows = () => fake.tables.api_tokens;
const rowFor = (id: string) => rows().find((r) => r.id === id) as Record<string, unknown>;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  fake = createFakeDb({
    users: [
      { id: "u1", is_allowed: true },
      { id: "u2", is_allowed: true },
      { id: "u3", is_allowed: false },
    ],
    api_tokens: [],
  });
  state.db = fake;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("mintApiToken", () => {
  it("returns a bg_ token once and stores only its hash and display prefix", async () => {
    const { token, record } = await mintApiToken("u1", { name: "  Grok  ", scopes: ["read"] });

    expect(token).toMatch(/^bg_[A-Za-z0-9_-]{43}$/);
    expect(rows()).toHaveLength(1);
    const row = rowFor(record.id);
    expect(row).toMatchObject({
      user_id: "u1",
      name: "Grok",
      prefix: token.slice(0, 8),
      token_hash: sha256(token),
      scopes: ["read"],
      expires_at: null,
    });
    // The plaintext is nowhere in storage.
    expect(JSON.stringify(fake.tables)).not.toContain(token.slice(8));

    expect(record).toEqual({
      id: row.id,
      name: "Grok",
      prefix: token.slice(0, 8),
      scopes: ["read"],
      client_id: null,
      created_at: T0.toISOString(),
      last_used_at: null,
      expires_at: null,
      revoked_at: null,
    });
    expect(record).not.toHaveProperty("token_hash");
    expect(record.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("makes a different token every time", async () => {
    const a = await mintApiToken("u1", { name: "a", scopes: ["read"] });
    const b = await mintApiToken("u1", { name: "b", scopes: ["read"] });
    expect(a.token).not.toBe(b.token);
    expect(rowFor(a.record.id).token_hash).not.toBe(rowFor(b.record.id).token_hash);
  });

  it("stores write as read and write, and sets an expiry when asked", async () => {
    const { record } = await mintApiToken("u1", { name: "Routine", scopes: ["write"], expiresInDays: 90 });
    expect(record.scopes).toEqual(["read", "write"]);
    expect(record.expires_at).toBe(new Date(T0.getTime() + 90 * DAY).toISOString());
  });

  it("refuses a blank name, no scopes and a nonsense expiry", async () => {
    await expect(mintApiToken("u1", { name: "  ", scopes: ["read"] })).rejects.toThrow(/name/);
    await expect(mintApiToken("u1", { name: "x", scopes: [] })).rejects.toThrow(/scopes/);
    await expect(mintApiToken("u1", { name: "x", scopes: ["read"], expiresInDays: 0 })).rejects.toThrow(/expiresInDays/);
    expect(rows()).toEqual([]);
  });
});

describe("verifyApiToken", () => {
  it("accepts a fresh token", async () => {
    const { token, record } = await mintApiToken("u1", { name: "Grok", scopes: ["write"] });
    expect(await verifyApiToken(token)).toEqual({ userId: "u1", tokenId: record.id, scopes: ["read", "write"] });
  });

  it("rejects a well-formed token nobody minted", async () => {
    await mintApiToken("u1", { name: "Grok", scopes: ["read"] });
    expect(await verifyApiToken(`bg_${"A".repeat(43)}`)).toBeNull();
  });

  it("rejects malformed tokens without a lookup", async () => {
    const { token } = await mintApiToken("u1", { name: "Grok", scopes: ["read"] });
    const fromSpy = vi.spyOn(fake, "from");
    for (const bad of ["", "bg_", token.slice(0, -1), `${token}x`, token.replace(/^bg_/, "gh_"), ` ${token}`]) {
      expect(await verifyApiToken(bad), bad).toBeNull();
    }
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("rejects a revoked token", async () => {
    const { token, record } = await mintApiToken("u1", { name: "Grok", scopes: ["read"] });
    expect(await revokeApiToken("u1", record.id)).toBe(true);
    expect(await verifyApiToken(token)).toBeNull();
  });

  it("rejects a token once it expires", async () => {
    const { token } = await mintApiToken("u1", { name: "Grok", scopes: ["read"], expiresInDays: 90 });
    vi.setSystemTime(T0.getTime() + 90 * DAY - 1000);
    expect(await verifyApiToken(token)).not.toBeNull();
    vi.setSystemTime(T0.getTime() + 90 * DAY);
    expect(await verifyApiToken(token)).toBeNull();
  });

  it("rejects the token of a user who is no longer allowed, or no longer exists", async () => {
    const { token } = await mintApiToken("u1", { name: "Grok", scopes: ["read"] });
    (fake.tables.users[0] as Record<string, unknown>).is_allowed = false;
    expect(await verifyApiToken(token)).toBeNull();

    const notAllowed = await mintApiToken("u3", { name: "Grok", scopes: ["read"] });
    expect(await verifyApiToken(notAllowed.token)).toBeNull();

    const orphan = await mintApiToken("gone", { name: "Grok", scopes: ["read"] });
    expect(await verifyApiToken(orphan.token)).toBeNull();
  });

  it("throws when the database can't be asked, without the token in the message", async () => {
    const { token } = await mintApiToken("u1", { name: "Grok", scopes: ["read"] });
    const realFrom = fake.from.bind(fake);
    vi.spyOn(fake, "from").mockImplementation((table) =>
      Object.assign(realFrom(table), {
        maybeSingle: () => Promise.resolve({ data: null, error: { message: "connection refused" } }),
      })
    );
    const err = await verifyApiToken(token).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Token lookup failed: connection refused/);
    expect((err as Error).message).not.toContain(token);
  });

  it("writes last_used_at at most once every five minutes", async () => {
    const { token, record } = await mintApiToken("u1", { name: "Grok", scopes: ["read"] });
    const lastUsed = () => rowFor(record.id).last_used_at;
    expect(lastUsed()).toBeUndefined();

    await verifyApiToken(token);
    expect(lastUsed()).toBe(T0.toISOString());

    const updates = vi.spyOn(fake, "from");
    vi.setSystemTime(T0.getTime() + LAST_USED_THROTTLE_MS - 1000);
    await verifyApiToken(token);
    expect(lastUsed()).toBe(T0.toISOString()); // fresh enough: no write
    expect(updates.mock.calls.map(([table]) => table)).toEqual(["api_tokens", "users"]);

    const later = T0.getTime() + LAST_USED_THROTTLE_MS;
    vi.setSystemTime(later);
    await verifyApiToken(token);
    expect(lastUsed()).toBe(new Date(later).toISOString());
  });
});

describe("hasScope", () => {
  it("treats write as including read, never the other way round", () => {
    expect(hasScope(["read"], "read")).toBe(true);
    expect(hasScope(["read"], "write")).toBe(false);
    expect(hasScope(["write"], "read")).toBe(true);
    expect(hasScope(["write"], "write")).toBe(true);
    expect(hasScope(["read", "write"], "write")).toBe(true);
    expect(hasScope([], "read")).toBe(false);
    expect(hasScope(["admin"], "read")).toBe(false);
  });
});

describe("listApiTokens / countActiveApiTokens / revokeApiToken", () => {
  it("lists only the user's own tokens, revoked ones included, never the hash", async () => {
    const mine = await mintApiToken("u1", { name: "Grok", scopes: ["read"] });
    const revoked = await mintApiToken("u1", { name: "Old", scopes: ["write"] });
    await mintApiToken("u2", { name: "Theirs", scopes: ["read"] });
    await revokeApiToken("u1", revoked.record.id);

    const list = await listApiTokens("u1");
    expect(list.map((t) => t.name).sort()).toEqual(["Grok", "Old"]);
    for (const t of list) {
      expect(Object.keys(t).sort()).toEqual(
        ["client_id", "created_at", "expires_at", "id", "last_used_at", "name", "prefix", "revoked_at", "scopes"].sort()
      );
    }
    expect(list.find((t) => t.id === mine.record.id)?.revoked_at).toBeNull();
    expect(list.find((t) => t.id === revoked.record.id)?.revoked_at).toBe(T0.toISOString());
  });

  it("counts only tokens that still work", async () => {
    await mintApiToken("u1", { name: "live", scopes: ["read"] });
    await mintApiToken("u1", { name: "expiring", scopes: ["read"], expiresInDays: 1 });
    const revoked = await mintApiToken("u1", { name: "revoked", scopes: ["read"] });
    await mintApiToken("u2", { name: "theirs", scopes: ["read"] });
    await revokeApiToken("u1", revoked.record.id);
    expect(await countActiveApiTokens("u1")).toBe(2);
    vi.setSystemTime(T0.getTime() + DAY);
    expect(await countActiveApiTokens("u1")).toBe(1);
  });

  it("revokes only the caller's own live token", async () => {
    const theirs = await mintApiToken("u2", { name: "Theirs", scopes: ["read"] });
    expect(await revokeApiToken("u1", theirs.record.id)).toBe(false);
    expect(rowFor(theirs.record.id).revoked_at).toBeUndefined();
    expect(await verifyApiToken(theirs.token)).not.toBeNull();

    expect(await revokeApiToken("u2", theirs.record.id)).toBe(true);
    expect(await revokeApiToken("u2", theirs.record.id)).toBe(false); // already revoked
    expect(await revokeApiToken("u2", "00000000-0000-4000-8000-000000000000")).toBe(false);
  });
});

describe("OAuth tokens: mintOAuthToken / findRefreshGrant / rotateOAuthToken", () => {
  const CLIENT = "c".repeat(43);
  const oauthToken = (scopes: ("read" | "write")[]) =>
    mintOAuthToken("u1", { clientId: CLIENT, name: "Claude", scopes, expiresInDays: 30 });

  it("stores the client and only the refresh token's hash; the access token is an ordinary bearer token", async () => {
    const { token, refreshToken, record } = await oauthToken(["write"]);
    expect(token).toMatch(/^bg_[A-Za-z0-9_-]{43}$/);
    expect(refreshToken).toMatch(/^bgr_[A-Za-z0-9_-]{43}$/);
    expect(record).toMatchObject({ name: "Claude", client_id: CLIENT, scopes: ["read", "write"] });
    expect(record).not.toHaveProperty("refresh_token_hash");
    expect(rowFor(record.id)).toMatchObject({
      client_id: CLIENT,
      token_hash: sha256(token),
      refresh_token_hash: sha256(refreshToken),
      expires_at: new Date(T0.getTime() + 30 * DAY).toISOString(),
    });
    expect(JSON.stringify(fake.tables)).not.toContain(refreshToken);
    expect(await verifyApiToken(token)).toMatchObject({ userId: "u1", tokenId: record.id });
    expect(await verifyApiToken(refreshToken)).toBeNull();
  });

  it("leaves dashboard tokens without a client or refresh token", async () => {
    const { record } = await mintApiToken("u1", { name: "Grok", scopes: ["read"] });
    expect(rowFor(record.id)).toMatchObject({ client_id: null, refresh_token_hash: null });
  });

  it("finds the grant behind a refresh token, and nothing for revoked, disallowed or unknown ones", async () => {
    const { refreshToken, record } = await oauthToken(["read"]);
    expect(await findRefreshGrant(refreshToken)).toEqual({
      tokenId: record.id,
      userId: "u1",
      clientId: CLIENT,
      scopes: ["read"],
    });
    expect(await findRefreshGrant(`bgr_${"A".repeat(43)}`)).toBeNull();
    expect(await findRefreshGrant("bg_nope")).toBeNull();

    (fake.tables.users[0] as Record<string, unknown>).is_allowed = false;
    expect(await findRefreshGrant(refreshToken)).toBeNull();
    (fake.tables.users[0] as Record<string, unknown>).is_allowed = true;

    await revokeApiToken("u1", record.id);
    expect(await findRefreshGrant(refreshToken)).toBeNull();
  });

  it("rotates in place; a second rotation with the old refresh token loses", async () => {
    const first = await oauthToken(["write"]);
    const grant = (await findRefreshGrant(first.refreshToken))!;
    vi.setSystemTime(T0.getTime() + DAY);
    const rotated = (await rotateOAuthToken(grant, first.refreshToken, { scopes: ["read"], expiresInDays: 30 }))!;
    expect(rotated.record.id).toBe(first.record.id);
    expect(rotated.record.scopes).toEqual(["read"]);
    expect(rows()).toHaveLength(1);
    expect(await verifyApiToken(first.token)).toBeNull();
    expect(await verifyApiToken(rotated.token)).toMatchObject({ scopes: ["read"] });
    expect(await findRefreshGrant(first.refreshToken)).toBeNull();

    expect(await rotateOAuthToken(grant, first.refreshToken, { scopes: ["read"], expiresInDays: 30 })).toBeNull();
  });

  it("refuses to widen", async () => {
    const first = await oauthToken(["read"]);
    const grant = (await findRefreshGrant(first.refreshToken))!;
    await expect(
      rotateOAuthToken(grant, first.refreshToken, { scopes: ["write"], expiresInDays: 30 })
    ).rejects.toThrow(/widen/);
    expect(await verifyApiToken(first.token)).not.toBeNull();
  });
});
