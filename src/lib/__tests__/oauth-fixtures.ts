import { createHash, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import type { FakeDb } from "./fake-db";

// Shared pieces of the OAuth route tests: a registered client, PKCE pairs,
// and a stand-in for the prune_oauth_clients Postgres function.

export const APP = "http://localhost:3000"; // APP_URL in setup.ts
export const RESOURCE = `${APP}/api/mcp`;
export const CLIENT_ID = "c".repeat(43);
export const OTHER_CLIENT_ID = "d".repeat(43);
export const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
export const USER_ID = "0b6f2c1e-3d4a-4f5b-8c6d-7e8f9a0b1c2d";
export const OTHER_USER_ID = "1c7a3d2f-4e5b-4a6c-9d7e-8f9a0b1c2d3e";

export const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex");

/** A fresh PKCE verifier and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** Tables with one allowed user (handle "graveyard_fan"), one disallowed user and one registered client. */
export function oauthTables(): Record<string, Record<string, unknown>[]> {
  return {
    users: [
      { id: USER_ID, handle: "graveyard_fan", is_allowed: true },
      { id: OTHER_USER_ID, handle: "someone_else", is_allowed: true },
    ],
    oauth_clients: [
      {
        client_id: CLIENT_ID,
        client_name: "Claude",
        redirect_uris: [REDIRECT, "http://localhost:6274/oauth/callback", "cursor://anysphere.cursor-mcp/oauth/callback"],
        token_endpoint_auth_method: "none",
        created_at: new Date().toISOString(),
      },
      {
        client_id: OTHER_CLIENT_ID,
        client_name: "Other",
        redirect_uris: ["https://other.example/callback"],
        token_endpoint_auth_method: "none",
        created_at: new Date().toISOString(),
      },
    ],
    oauth_codes: [],
    api_tokens: [],
  };
}

const isPast = (iso: unknown) => typeof iso === "string" && Date.parse(iso) <= Date.now();

/**
 * What the registration functions of the connector hardening migration do,
 * against the fake tables:
 *
 * public.prune_oauth_clients drops (a) clients older than p_unused_minutes with
 * no oauth_codes row and no api_tokens row, and (b) clients older than
 * p_stale_days with no unrevoked token and no unexpired code, then returns how
 * many remain.
 *
 * public.evict_oauth_client drops the oldest client with no live token
 * (unrevoked and unexpired) and no unused, unexpired code, and returns whether
 * it found one. Codes cascade with their client, as the foreign key does.
 */
export function installPruneFunction(fake: FakeDb): void {
  const tokensOf = (clientId: unknown) => (fake.tables.api_tokens ?? []).filter((t) => t.client_id === clientId);
  const codesOf = (clientId: unknown) => (fake.tables.oauth_codes ?? []).filter((o) => o.client_id === clientId);
  const drop = (gone: (c: Record<string, unknown>) => boolean) => {
    const goneIds = new Set((fake.tables.oauth_clients ?? []).filter(gone).map((c) => c.client_id));
    fake.tables.oauth_clients = (fake.tables.oauth_clients ?? []).filter((c) => !goneIds.has(c.client_id));
    fake.tables.oauth_codes = (fake.tables.oauth_codes ?? []).filter((o) => !goneIds.has(o.client_id));
  };

  fake.functions.prune_oauth_clients = (args) => {
    const unusedBefore = Date.now() - Number(args.p_unused_minutes) * 60 * 1000;
    const staleBefore = Date.now() - Number(args.p_stale_days) * 24 * 60 * 60 * 1000;
    const createdBefore = (c: Record<string, unknown>, cutoff: number) => Date.parse(String(c.created_at)) < cutoff;
    drop((c) => createdBefore(c, unusedBefore) && codesOf(c.client_id).length === 0 && tokensOf(c.client_id).length === 0);
    drop(
      (c) =>
        createdBefore(c, staleBefore) &&
        tokensOf(c.client_id).every((t) => t.revoked_at) &&
        codesOf(c.client_id).every((o) => isPast(o.expires_at))
    );
    return fake.tables.oauth_clients.length;
  };

  fake.functions.evict_oauth_client = () => {
    const evictable = (fake.tables.oauth_clients ?? [])
      .filter(
        (c) =>
          tokensOf(c.client_id).every((t) => t.revoked_at || isPast(t.expires_at)) &&
          codesOf(c.client_id).every((o) => o.used_at || isPast(o.expires_at))
      )
      .sort((a, b) => Date.parse(String(a.created_at)) - Date.parse(String(b.created_at)));
    if (evictable.length === 0) return false;
    const victim = evictable[0].client_id;
    drop((c) => c.client_id === victim);
    return true;
  };
}

/** An /oauth/authorize query for the seeded client, with overrides; null deletes a parameter. */
export function authorizeQuery(overrides: Record<string, string | null> = {}, challenge = pkcePair().challenge) {
  const params: Record<string, string | null> = {
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    scope: "read",
    state: "st-123",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
    ...overrides,
  };
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== null) query.set(key, value);
  return query;
}

/** A form-encoded POST. */
export function formPost(url: string, fields: Record<string, string>, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

/** A JSON POST. */
export function jsonPost(url: string, body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** The Location header as a URL. */
export function locationOf(res: Response): URL {
  const location = res.headers.get("location");
  if (!location) throw new Error(`No Location header (status ${res.status})`);
  return new URL(location);
}
