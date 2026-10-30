import { NextRequest, NextResponse } from "next/server";
import { findRefreshGrant, hashToken, isExpired, mintOAuthToken, normalizeScopes, rotateOAuthToken } from "@/lib/api-tokens";
import type { ApiScope } from "@/lib/api-tokens";
import {
  ACCESS_TOKEN_DAYS,
  ACCESS_TOKEN_SECONDS,
  corsHeaders,
  getClient,
  isOurResource,
  isPkceValue,
  isUserAllowed,
  mcpResource,
  oauthError,
  parseScopeParam,
  pkceChallenge,
  preflight,
  scopeString,
  touchClient,
} from "@/lib/oauth";
import type { OAuthErrorCode } from "@/lib/oauth";
import { db } from "@/lib/supabase";

// The token endpoint (RFC 6749 §3.2), public: clients call it server to
// server or, like the MCP Inspector, from the browser. Two grants:
//
//  authorization_code: trades a code from /api/oauth/decision plus its PKCE
//    verifier for an api_tokens row (30 days, tagged with the client) and a
//    refresh token. A code works once: the request that flips used_at wins,
//    a replay loses.
//  refresh_token: rotates. The same row gets a new access token and a new
//    refresh token, so the presented pair dies and the Assistants panel keeps
//    one entry per connected client. Scopes may narrow, never widen.
//
// Codes, verifiers and tokens are never logged and never echoed in an error.

const METHODS = "POST, OPTIONS";
const HEADERS = { ...corsHeaders(METHODS), "Cache-Control": "no-store", Pragma: "no-cache" };
const BODY_MAX = 64 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_PARAMS = [
  "grant_type",
  "code",
  "redirect_uri",
  "client_id",
  "code_verifier",
  "resource",
  "refresh_token",
  "scope",
];

const fail = (error: OAuthErrorCode, description: string, status = 400) =>
  oauthError(error, description, status, HEADERS);

function tokenResponse(token: string, refreshToken: string, scopes: ApiScope[]) {
  return NextResponse.json(
    {
      access_token: token,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_SECONDS,
      refresh_token: refreshToken,
      scope: scopeString(scopes),
    },
    { headers: HEADERS }
  );
}

/**
 * The request parameters: application/x-www-form-urlencoded as the spec
 * requires, or a flat JSON object of strings, which some clients send. Null
 * when the body is neither.
 */
async function readParams(req: NextRequest): Promise<URLSearchParams | null> {
  const text = await req.text().catch(() => null);
  if (text === null || text.length > BODY_MAX) return null;
  const contentType = req.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("json")) return new URLSearchParams(text);

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined) continue;
    if (typeof value !== "string") return null;
    params.set(key, value);
  }
  return params;
}

async function exchangeCode(params: URLSearchParams): Promise<Response> {
  const code = params.get("code");
  const redirectUri = params.get("redirect_uri");
  const clientId = params.get("client_id");
  const verifier = params.get("code_verifier");
  if (!code || !redirectUri || !clientId || !verifier) {
    return fail("invalid_request", "code, redirect_uri, client_id and code_verifier are required");
  }
  if (!isPkceValue(verifier)) {
    return fail("invalid_request", "code_verifier must be 43 to 128 characters of A-Z, a-z, 0-9, '.', '_', '~' and '-'");
  }
  const resource = params.get("resource");
  if (resource !== null && !isOurResource(resource)) return fail("invalid_target", `resource must be ${mcpResource()}`);

  const client = await getClient(clientId);
  if (!client) return fail("invalid_client", "Unknown client_id", 401);

  const codeHash = hashToken(code);
  const { data: row, error } = await db()
    .from("oauth_codes")
    .select("code_hash, client_id, user_id, redirect_uri, scopes, code_challenge, expires_at, used_at")
    .eq("code_hash", codeHash)
    .maybeSingle();
  if (error) throw new Error(`Code lookup failed: ${error.message}`);
  // Unknown, used, expired and another client's codes all read the same.
  const badCode = () => fail("invalid_grant", "The authorization code is invalid, expired or already used");
  if (!row || row.used_at || isExpired(row.expires_at)) return badCode();
  if (row.client_id !== clientId) return badCode();
  if (row.redirect_uri !== redirectUri) return fail("invalid_grant", "redirect_uri doesn't match the authorization request");
  if (pkceChallenge(verifier) !== row.code_challenge) return fail("invalid_grant", "code_verifier doesn't match the code_challenge");

  // Single use: only the request whose update flips used_at gets a token.
  const { data: claimed, error: claimError } = await db()
    .from("oauth_codes")
    .update({ used_at: new Date().toISOString() })
    .eq("code_hash", codeHash)
    .is("used_at", null)
    .select("code_hash")
    .maybeSingle();
  if (claimError) throw new Error(`Couldn't mark the code used: ${claimError.message}`);
  if (!claimed) return badCode();

  const userId = String(row.user_id);
  if (!(await isUserAllowed(userId))) return fail("invalid_grant", "This account can no longer use this server");

  const scopes = normalizeScopes(
    (Array.isArray(row.scopes) ? row.scopes : []).filter((s: unknown): s is ApiScope => s === "read" || s === "write")
  );
  const { token, refreshToken } = await mintOAuthToken(userId, {
    clientId,
    name: client.client_name,
    scopes,
    expiresInDays: ACCESS_TOKEN_DAYS,
  });

  await touchClient(clientId);
  // Housekeeping: codes are worthless a day after they expire.
  const { error: pruneError } = await db()
    .from("oauth_codes")
    .delete()
    .lt("expires_at", new Date(Date.now() - DAY_MS).toISOString());
  if (pruneError) console.error("POST /oauth/token: pruning old codes failed:", pruneError.message);

  return tokenResponse(token, refreshToken, scopes);
}

async function refresh(params: URLSearchParams): Promise<Response> {
  const refreshToken = params.get("refresh_token");
  const clientId = params.get("client_id");
  if (!refreshToken || !clientId) return fail("invalid_request", "refresh_token and client_id are required");
  const requested = parseScopeParam(params.get("scope"));
  if (requested === null) return fail("invalid_scope", 'scope may only contain "read" and "write"');
  const resource = params.get("resource");
  if (resource !== null && !isOurResource(resource)) return fail("invalid_target", `resource must be ${mcpResource()}`);

  const client = await getClient(clientId);
  if (!client) return fail("invalid_client", "Unknown client_id", 401);

  const grant = await findRefreshGrant(refreshToken);
  const badToken = () => fail("invalid_grant", "The refresh token is invalid, revoked or already used");
  if (!grant || grant.clientId !== clientId) return badToken();

  const scopes = requested.length > 0 ? normalizeScopes(requested) : grant.scopes;
  if (!scopes.every((s) => grant.scopes.includes(s))) {
    return fail("invalid_scope", "A refresh can't ask for more than was originally granted");
  }

  const rotated = await rotateOAuthToken(grant, refreshToken, { scopes, expiresInDays: ACCESS_TOKEN_DAYS });
  if (!rotated) return badToken(); // another request rotated it first
  await touchClient(clientId);
  return tokenResponse(rotated.token, rotated.refreshToken, scopes);
}

export async function POST(req: NextRequest) {
  const params = await readParams(req);
  if (!params) return fail("invalid_request", "Expected an application/x-www-form-urlencoded body");
  const repeated = TOKEN_PARAMS.find((name) => params.getAll(name).length > 1);
  if (repeated) return fail("invalid_request", `${repeated} was sent more than once`);

  const grantType = params.get("grant_type");
  try {
    if (grantType === "authorization_code") return await exchangeCode(params);
    if (grantType === "refresh_token") return await refresh(params);
  } catch (err) {
    // Detail stays server-side; it never includes a code, verifier or token.
    console.error(`POST /oauth/token (${grantType}):`, err);
    return fail("server_error", "Couldn't issue a token. Try again later.", 500);
  }
  if (!grantType) return fail("invalid_request", "grant_type is required");
  return fail("unsupported_grant_type", 'grant_type must be "authorization_code" or "refresh_token"');
}

export function OPTIONS() {
  return preflight(METHODS);
}
