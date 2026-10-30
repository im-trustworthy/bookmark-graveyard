import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { db } from "./supabase";

// Personal access tokens: how an AI assistant (through the MCP connector)
// acts for one user. A token is "bg_" plus 32 random bytes in base64url. Only
// its SHA-256 hex is stored, with the first eight characters as a display
// prefix; the plaintext is returned once by mintApiToken and never logged or
// put in an error message. The table is managed from the dashboard through the
// cookie-only /api/tokens routes, so a token can never mint another token.
//
// Tokens minted through OAuth (src/lib/oauth.ts) are the same rows with
// client_id set and a refresh token ("bgr_" plus 32 random bytes, stored as
// refresh_token_hash). Refreshing rewrites that row in place, so the old access
// and refresh tokens stop working together.

export type ApiScope = "read" | "write";

/** Every column the dashboard may see: everything except token_hash and refresh_token_hash. */
export interface ApiTokenRecord {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiScope[];
  client_id: string | null;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface VerifiedToken {
  userId: string;
  tokenId: string;
  scopes: ApiScope[];
}

export const TOKEN_PREFIX = "bg_";
/** OAuth refresh tokens: a different prefix, so one can never pass for an access token. */
export const REFRESH_TOKEN_PREFIX = "bgr_";
/** Characters of the token kept for display ("bg_" plus five). */
export const DISPLAY_PREFIX_LENGTH = 8;
/** At most this many tokens per user may be live (not revoked, not expired) at once. */
export const MAX_ACTIVE_TOKENS = 25;
/** last_used_at is rewritten at most this often, so a chatty client doesn't turn every call into a write. */
export const LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

const PUBLIC_COLUMNS = "id, name, prefix, scopes, client_id, created_at, last_used_at, expires_at, revoked_at";
// "bg_" + base64url of 32 bytes (43 characters, no padding).
const TOKEN_SHAPE = /^bg_[A-Za-z0-9_-]{43}$/;
const REFRESH_TOKEN_SHAPE = /^bgr_[A-Za-z0-9_-]{43}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `write` implies `read`. */
export function hasScope(scopes: readonly string[], needed: ApiScope): boolean {
  return scopes.includes(needed) || (needed === "read" && scopes.includes("write"));
}

/** The stored form of a scope set: ["read"] or ["read", "write"]. */
export function normalizeScopes(scopes: readonly ApiScope[]): ApiScope[] {
  if (scopes.length === 0 || scopes.some((s) => s !== "read" && s !== "write")) {
    throw new Error("Token scopes must be a non-empty list of 'read' and 'write'");
  }
  return scopes.includes("write") ? ["read", "write"] : ["read"];
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Whether a token row is past its expiry at `now` (no expiry: never). */
export function isExpired(expiresAt: string | null | undefined, now = Date.now()): boolean {
  return !!expiresAt && Date.parse(expiresAt) <= now;
}

function toRecord(row: Record<string, unknown>): ApiTokenRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    prefix: String(row.prefix),
    scopes: Array.isArray(row.scopes) ? (row.scopes.filter((s) => s === "read" || s === "write") as ApiScope[]) : [],
    client_id: (row.client_id as string | null | undefined) ?? null,
    created_at: String(row.created_at),
    last_used_at: (row.last_used_at as string | null | undefined) ?? null,
    expires_at: (row.expires_at as string | null | undefined) ?? null,
    revoked_at: (row.revoked_at as string | null | undefined) ?? null,
  };
}

const newSecret = (prefix: string) => prefix + randomBytes(32).toString("base64url");

function expiryFrom(now: Date, days: number | null): string | null {
  if (days !== null && !(Number.isInteger(days) && days > 0)) {
    throw new Error("expiresInDays must be a positive whole number of days");
  }
  return days === null ? null : new Date(now.getTime() + days * DAY_MS).toISOString();
}

async function insertToken(
  userId: string,
  opts: {
    name: string;
    scopes: ApiScope[];
    expiresInDays: number | null;
    clientId: string | null;
    refreshToken: string | null;
  }
): Promise<{ token: string; record: ApiTokenRecord }> {
  const name = opts.name.trim();
  if (!name) throw new Error("Token name is required");
  const scopes = normalizeScopes(opts.scopes);
  const now = new Date();
  const expiresAt = expiryFrom(now, opts.expiresInDays);

  const token = newSecret(TOKEN_PREFIX);
  const { data, error } = await db()
    .from("api_tokens")
    .insert({
      id: randomUUID(),
      user_id: userId,
      name,
      prefix: token.slice(0, DISPLAY_PREFIX_LENGTH),
      token_hash: hashToken(token),
      scopes,
      client_id: opts.clientId,
      refresh_token_hash: opts.refreshToken === null ? null : hashToken(opts.refreshToken),
      created_at: now.toISOString(),
      expires_at: expiresAt,
    })
    .select(PUBLIC_COLUMNS)
    .single();
  if (error || !data) throw new Error(`Couldn't save the token: ${error?.message ?? "no row returned"}`);
  return { token, record: toRecord(data) };
}

/**
 * Creates a token for `userId` and returns its plaintext. This is the only
 * time the plaintext exists outside the caller's hands: the row keeps its hash.
 */
export async function mintApiToken(
  userId: string,
  opts: { name: string; scopes: ApiScope[]; expiresInDays?: number | null }
): Promise<{ token: string; record: ApiTokenRecord }> {
  return insertToken(userId, {
    name: opts.name,
    scopes: opts.scopes,
    expiresInDays: opts.expiresInDays ?? null,
    clientId: null,
    refreshToken: null,
  });
}

/**
 * OAuth: a token for `userId` tagged with the client that obtained it, plus a
 * refresh token. Both plaintexts are returned once; the row keeps their hashes.
 */
export async function mintOAuthToken(
  userId: string,
  opts: { clientId: string; name: string; scopes: ApiScope[]; expiresInDays: number }
): Promise<{ token: string; refreshToken: string; record: ApiTokenRecord }> {
  if (!opts.clientId) throw new Error("clientId is required");
  const refreshToken = newSecret(REFRESH_TOKEN_PREFIX);
  const { token, record } = await insertToken(userId, {
    name: opts.name,
    scopes: opts.scopes,
    expiresInDays: opts.expiresInDays,
    clientId: opts.clientId,
    refreshToken,
  });
  return { token, refreshToken, record };
}

/** The token row a refresh token belongs to, as far as the refresh grant needs it. */
export interface RefreshGrant {
  tokenId: string;
  userId: string;
  clientId: string | null;
  scopes: ApiScope[];
}

/**
 * The grant behind a presented refresh token, or null when it is unknown (or
 * already rotated away), revoked, or belongs to a user who is no longer
 * allowed. An expired access token can still be refreshed: that is what
 * refreshing is for. Throws only when the database can't be asked.
 */
export async function findRefreshGrant(refreshToken: string): Promise<RefreshGrant | null> {
  if (!REFRESH_TOKEN_SHAPE.test(refreshToken)) return null; // not one of ours: no lookup
  const { data: row, error } = await db()
    .from("api_tokens")
    .select("id, user_id, client_id, scopes, revoked_at")
    .eq("refresh_token_hash", hashToken(refreshToken))
    .maybeSingle();
  if (error) throw new Error(`Refresh token lookup failed: ${error.message}`);
  if (!row || row.revoked_at) return null;

  const { data: user, error: userError } = await db()
    .from("users")
    .select("is_allowed")
    .eq("id", row.user_id)
    .maybeSingle();
  if (userError) throw new Error(`Token owner lookup failed: ${userError.message}`);
  if (!user?.is_allowed) return null;

  const scopes = Array.isArray(row.scopes) ? row.scopes.filter((s: unknown) => s === "read" || s === "write") : [];
  return {
    tokenId: String(row.id),
    userId: String(row.user_id),
    clientId: (row.client_id as string | null | undefined) ?? null,
    scopes,
  };
}

/**
 * Refresh-token rotation: writes a new access token and a new refresh token
 * onto the grant's row (with `scopes`, which may only narrow, and a fresh
 * expiry), so the presented pair stops working. The write is conditional on
 * the row still holding `refreshToken`, so of two concurrent refreshes with the
 * same token only one wins; the other gets null.
 */
export async function rotateOAuthToken(
  grant: RefreshGrant,
  refreshToken: string,
  opts: { scopes: ApiScope[]; expiresInDays: number }
): Promise<{ token: string; refreshToken: string; record: ApiTokenRecord } | null> {
  const scopes = normalizeScopes(opts.scopes);
  if (!scopes.every((s) => grant.scopes.includes(s))) throw new Error("A refresh can't widen a token's scopes");
  const now = new Date();
  const token = newSecret(TOKEN_PREFIX);
  const nextRefreshToken = newSecret(REFRESH_TOKEN_PREFIX);
  const { data, error } = await db()
    .from("api_tokens")
    .update({
      token_hash: hashToken(token),
      prefix: token.slice(0, DISPLAY_PREFIX_LENGTH),
      refresh_token_hash: hashToken(nextRefreshToken),
      scopes,
      expires_at: expiryFrom(now, opts.expiresInDays),
      last_used_at: now.toISOString(),
    })
    .eq("id", grant.tokenId)
    .eq("refresh_token_hash", hashToken(refreshToken))
    .is("revoked_at", null)
    .select(PUBLIC_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(`Couldn't rotate the token: ${error.message}`);
  if (!data) return null;
  return { token, refreshToken: nextRefreshToken, record: toRecord(data) };
}

/**
 * The user and scopes a presented token stands for, or null when it is
 * unknown, revoked, expired, or belongs to a user who is no longer allowed.
 * Throws only when the database can't be asked.
 */
export async function verifyApiToken(token: string): Promise<VerifiedToken | null> {
  if (!TOKEN_SHAPE.test(token)) return null; // not one of ours: no lookup
  const { data: row, error } = await db()
    .from("api_tokens")
    .select("id, user_id, scopes, expires_at, revoked_at, last_used_at")
    .eq("token_hash", hashToken(token))
    .maybeSingle();
  if (error) throw new Error(`Token lookup failed: ${error.message}`);
  if (!row || row.revoked_at || isExpired(row.expires_at)) return null;

  // Checked on every call, so removing someone from the allowlist cuts off their tokens too.
  const { data: user, error: userError } = await db()
    .from("users")
    .select("is_allowed")
    .eq("id", row.user_id)
    .maybeSingle();
  if (userError) throw new Error(`Token owner lookup failed: ${userError.message}`);
  if (!user?.is_allowed) return null;

  const now = Date.now();
  const lastUsed = row.last_used_at ? Date.parse(row.last_used_at) : NaN;
  if (!(now - lastUsed < LAST_USED_THROTTLE_MS)) {
    const { error: touchError } = await db()
      .from("api_tokens")
      .update({ last_used_at: new Date(now).toISOString() })
      .eq("id", row.id);
    // Bookkeeping only: a failed write must not turn a valid token away.
    if (touchError) console.error(`verifyApiToken: last_used_at update failed for token ${row.id}:`, touchError.message);
  }

  const scopes = Array.isArray(row.scopes) ? row.scopes.filter((s: unknown) => s === "read" || s === "write") : [];
  return { userId: String(row.user_id), tokenId: String(row.id), scopes };
}

/** Every token the user has made, newest first, revoked ones included. Never the hashes. */
export async function listApiTokens(userId: string): Promise<ApiTokenRecord[]> {
  const { data, error } = await db()
    .from("api_tokens")
    .select(PUBLIC_COLUMNS)
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Couldn't list tokens: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map(toRecord);
}

/** How many of the user's tokens still work (not revoked, not expired). */
export async function countActiveApiTokens(userId: string): Promise<number> {
  const { data, error } = await db()
    .from("api_tokens")
    .select("id, expires_at")
    .eq("user_id", userId)
    .is("revoked_at", null);
  if (error) throw new Error(`Couldn't count tokens: ${error.message}`);
  const now = Date.now();
  return ((data ?? []) as { expires_at: string | null }[]).filter((row) => !isExpired(row.expires_at, now)).length;
}

/**
 * Revokes one of the user's own tokens. False when there is no such live
 * token: someone else's, already revoked, or never existed.
 */
export async function revokeApiToken(userId: string, tokenId: string): Promise<boolean> {
  const { data, error } = await db()
    .from("api_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", tokenId)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .select("id");
  if (error) throw new Error(`Couldn't revoke the token: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}
