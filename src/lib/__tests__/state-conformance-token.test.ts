import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./fake-db";
import type { FakeDb } from "./fake-db";
import { expectConformance, MoveLog } from "./conformance";
import type { NotExercised } from "./conformance";

// The token lifecycle against its table. The real functions in src/lib/api-tokens.ts mint, expire (time
// passes under vi.setSystemTime), rotate and revoke rows in the fake database, and tokenStatus reads the
// stored row after every step. A step that changed the row's state is held against TOKEN_TRANSITIONS; a
// step that left it as it was (a verify, a rotation of a live token, a refused call) is no move.
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase", () => ({ db: () => state.db }));

import {
  findRefreshGrant,
  mintApiToken,
  mintOAuthToken,
  revokeApiToken,
  revokeClientTokens,
  revokeReusedRefreshToken,
  revokeTokenRows,
  rotateOAuthToken,
  verifyApiToken,
} from "@/lib/api-tokens";
import { canMoveToken, TOKEN_TRANSITIONS, tokenStatus } from "@/lib/state/token";
import type { TokenStatus } from "@/lib/state/token";

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-10-29T12:00:00.000Z");

const moves = new MoveLog<TokenStatus>();
let fake: FakeDb;

const rowFor = (id: string) => fake.tables.api_tokens.find((r) => r.id === id) as { revoked_at: string | null; expires_at: string | null };
const statusOf = (id: string) => tokenStatus(rowFor(id), Date.now());

/** Runs one call and records the move it made to the token's stored state, if it made one. */
async function step<T>(id: string, call: () => Promise<T>): Promise<T> {
  const before = statusOf(id);
  const result = await call();
  const after = statusOf(id);
  if (before !== after) moves.record(before, after);
  return result;
}
/** Time passing is a step too: nothing writes, and the state can still change. */
const wait = (id: string, ms: number) =>
  step(id, async () => {
    vi.setSystemTime(Date.now() + ms);
  });

async function dashboardToken(expiresInDays: number | null) {
  const { token, record } = await mintApiToken("u1", { name: "Assistant", scopes: ["read", "write"], expiresInDays });
  return { token, id: record.id };
}
async function oauthToken(clientId = "client-a") {
  const minted = await mintOAuthToken("u1", { clientId, name: "Connector", scopes: ["read", "write"], expiresInDays: 1 });
  return { token: minted.token, refreshToken: minted.refreshToken, id: minted.record.id };
}
/** The refresh grant a presented refresh token stands for, then the rotation it asks for. */
async function rotate(id: string, refreshToken: string) {
  return step(id, async () => {
    const grant = await findRefreshGrant(refreshToken);
    return grant ? rotateOAuthToken(grant, refreshToken, { scopes: ["read"], expiresInDays: 1 }) : null;
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  fake = createFakeDb({ users: [{ id: "u1", is_allowed: true }], api_tokens: [] });
  state.db = fake;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("token state conformance", () => {
  it("a token with an expiry is active, then expired once its time has passed", async () => {
    const { token, id } = await dashboardToken(1);
    expect(statusOf(id)).toBe("active");
    expect(await verifyApiToken(token)).toMatchObject({ tokenId: id });

    await wait(id, DAY - 1);
    expect(statusOf(id)).toBe("active");
    await wait(id, 1);
    expect(statusOf(id)).toBe("expired");
    expect(await verifyApiToken(token)).toBeNull();
  });

  it("a token with no expiry stays active however long it sits", async () => {
    const { id } = await dashboardToken(null);
    await wait(id, 3650 * DAY);
    expect(statusOf(id)).toBe("active");
  });

  it("revoking a live token (by id) moves active to revoked", async () => {
    const { token, id } = await dashboardToken(90);
    expect(await step(id, () => revokeApiToken("u1", id))).toBe(true);
    expect(statusOf(id)).toBe("revoked");
    expect(await verifyApiToken(token)).toBeNull();
  });

  it("revoking an expired token moves expired to revoked", async () => {
    const { id } = await dashboardToken(1);
    await wait(id, 2 * DAY);
    expect(await step(id, () => revokeApiToken("u1", id))).toBe(true);
    expect(statusOf(id)).toBe("revoked");
  });

  it("revokeTokenRows by id, and by user and client, revoke from both live states", async () => {
    const byId = await oauthToken("client-a");
    expect((await step(byId.id, () => revokeTokenRows({ id: byId.id }))).revokedIds).toEqual([byId.id]);

    const byClient = await oauthToken("client-b");
    await wait(byClient.id, 2 * DAY); // expired
    expect(await step(byClient.id, () => revokeClientTokens("u1", "client-b"))).toBe(1);
    expect([statusOf(byId.id), statusOf(byClient.id)]).toEqual(["revoked", "revoked"]);
  });

  it("a refresh moves an expired OAuth token back to active, and a refresh of a live one moves nothing", async () => {
    const first = await oauthToken();
    await wait(first.id, 2 * DAY);
    expect(statusOf(first.id)).toBe("expired");

    const rotated = await rotate(first.id, first.refreshToken);
    expect(rotated).not.toBeNull();
    expect(statusOf(first.id)).toBe("active");
    expect(await verifyApiToken(rotated!.token)).toMatchObject({ tokenId: first.id });

    // Rotating a token that is still live changes its secrets and expiry, not its state.
    const again = await rotate(first.id, rotated!.refreshToken);
    expect(again).not.toBeNull();
    expect(statusOf(first.id)).toBe("active");
  });

  it("replaying a rotated-away refresh token revokes the row", async () => {
    const first = await oauthToken();
    const rotated = await rotate(first.id, first.refreshToken);
    expect(statusOf(first.id)).toBe("active");

    expect(await step(first.id, () => revokeReusedRefreshToken(first.refreshToken))).toBe(first.id);
    expect(statusOf(first.id)).toBe("revoked");
    expect(await verifyApiToken(rotated!.token)).toBeNull();
  });

  it("an expired token's reuse detection also revokes it", async () => {
    const first = await oauthToken();
    const rotated = await rotate(first.id, first.refreshToken);
    await wait(first.id, 2 * DAY);
    expect(statusOf(first.id)).toBe("expired");

    expect(await step(first.id, () => revokeReusedRefreshToken(first.refreshToken))).toBe(first.id);
    expect(statusOf(first.id)).toBe("revoked");
    expect(rotated).not.toBeNull();
  });

  it("revoked is terminal: nothing leaves it, however it is asked", async () => {
    const first = await oauthToken();
    const grant = await findRefreshGrant(first.refreshToken);
    const rotated = await rotate(first.id, first.refreshToken);
    expect(grant).not.toBeNull();
    await step(first.id, () => revokeApiToken("u1", first.id));
    const revokedAt = rowFor(first.id).revoked_at;
    expect(statusOf(first.id)).toBe("revoked");

    // Rotate: the refresh lookup no longer finds it, and a grant read earlier is turned away by the write.
    expect(await rotate(first.id, rotated!.refreshToken)).toBeNull();
    expect(await step(first.id, () => rotateOAuthToken(grant!, rotated!.refreshToken, { scopes: ["read"], expiresInDays: 30 }))).toBeNull();
    // Verify: the token is refused, and the refusal writes nothing.
    expect(await step(first.id, () => verifyApiToken(rotated!.token))).toBeNull();
    // Revoke again, by every route: it matches nothing, and keeps the first time.
    expect(await step(first.id, () => revokeApiToken("u1", first.id))).toBe(false);
    expect((await step(first.id, () => revokeTokenRows({ id: first.id }))).revokedIds).toEqual([]);
    expect(await step(first.id, () => revokeClientTokens("u1", "client-a"))).toBe(0);
    expect(await step(first.id, () => revokeReusedRefreshToken(first.refreshToken))).toBe(first.id);
    // Time passing does not matter either: a revoked row stays revoked past its expiry.
    await wait(first.id, 400 * DAY);

    expect(statusOf(first.id)).toBe("revoked");
    expect(rowFor(first.id).revoked_at).toBe(revokedAt);
  });
});

// Entries the fakes cannot produce, each with its reason. None today: every entry of the table is made by
// a real function in the scenarios above.
const NOT_EXERCISED: NotExercised<TokenStatus>[] = [];

describe("token table", () => {
  it("every move the token functions made is allowed, and every allowed move was made", () => {
    expectConformance({ transitions: TOKEN_TRANSITIONS, canMove: canMoveToken, moves: moves.moves, notExercised: NOT_EXERCISED });
  });

  it("would catch a move out of revoked, and an entry nothing makes", () => {
    const withRecovery = [...moves.moves, { from: "revoked" as const, to: "active" as const }];
    expect(() => expectConformance({ transitions: TOKEN_TRANSITIONS, canMove: canMoveToken, moves: withRecovery })).toThrow();
    const withoutRefresh = moves.moves.filter((m) => !(m.from === "expired" && m.to === "active"));
    expect(() => expectConformance({ transitions: TOKEN_TRANSITIONS, canMove: canMoveToken, moves: withoutRefresh })).toThrow();
  });
});
