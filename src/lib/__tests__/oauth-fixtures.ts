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

/**
 * What public.prune_oauth_clients does, against the fake tables: drop clients
 * older than p_max_age_days with no api_tokens row and no oauth_codes row, then
 * return how many remain.
 */
export function installPruneFunction(fake: FakeDb): void {
  fake.functions.prune_oauth_clients = (args) => {
    const days = Number(args.p_max_age_days);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const tokens = fake.tables.api_tokens ?? [];
    const codes = fake.tables.oauth_codes ?? [];
    fake.tables.oauth_clients = (fake.tables.oauth_clients ?? []).filter(
      (c) =>
        !(Date.parse(String(c.created_at)) < cutoff) ||
        tokens.some((t) => t.client_id === c.client_id) ||
        codes.some((o) => o.client_id === c.client_id)
    );
    return fake.tables.oauth_clients.length;
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
