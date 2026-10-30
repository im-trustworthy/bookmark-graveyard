import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { hashToken, normalizeScopes } from "./api-tokens";
import type { ApiScope } from "./api-tokens";
import { sign, verifySignature } from "./crypto";
import { appUrl } from "./env";
import { db } from "./supabase";

// The app as a small OAuth 2.1 authorization server for its own tokens, so web
// chat products (claude.ai, ChatGPT, grok.com connectors, the MCP Inspector)
// can connect without a pasted token:
//
//   1. The client reads /.well-known/oauth-protected-resource (RFC 9728) and
//      /.well-known/oauth-authorization-server (RFC 8414).
//   2. It registers at POST /oauth/register (RFC 7591): public clients only.
//   3. It sends the user to GET /oauth/authorize with a PKCE S256 challenge
//      (RFC 7636). The user signs in with X if needed and approves on the
//      consent page; POST /api/oauth/decision issues a five-minute, single-use
//      code bound to the client, redirect URI, scopes and challenge.
//   4. It trades the code and its verifier at POST /oauth/token for an
//      ordinary api_tokens row (client_id set, 30 days) plus a rotating
//      refresh token. A rotated-away refresh token presented again revokes
//      the row, and a refresh after 90 days without use is refused.
//
// Codes, access tokens and refresh tokens are stored only as SHA-256 hex and
// never logged. Every URL here comes from APP_URL, never from a request's Host.
// Nothing here redirects the browser to a client before the user has acted:
// a bad authorization request gets an error page with a link back (RFC 9700
// §4.11), so a registered redirect URI can't turn this domain into a redirector.

export const APP_NAME = "Bookmark Graveyard";
export const SUPPORTED_SCOPES: readonly ApiScope[] = ["read", "write"];

export const CODE_TTL_MS = 5 * 60 * 1000;
export const CONSENT_TTL_MS = 10 * 60 * 1000;
export const ACCESS_TOKEN_DAYS = 30;
export const ACCESS_TOKEN_SECONDS = ACCESS_TOKEN_DAYS * 24 * 60 * 60;
/** A refresh is refused once the connection has gone this long without use (API calls and refreshes both count). */
export const REFRESH_IDLE_DAYS = 90;
/** At this many registrations, a new one first evicts the oldest registration with no live token. */
export const MAX_CLIENTS = 1000;
/** Registrations older than this that never produced a code or a token are pruned. */
export const CLIENT_UNUSED_MINUTES = 60;
/** Registrations older than this whose tokens are all revoked, with no pending code, are pruned. */
export const CLIENT_STALE_DAYS = 30;
/** How many evictions one registration may make before it registers anyway. */
export const MAX_EVICTIONS_PER_REGISTRATION = 5;
/** The largest body /oauth/register and /oauth/token read. */
export const OAUTH_BODY_MAX = 64 * 1024;
export const CLIENT_NAME_MAX = 100;
export const DEFAULT_CLIENT_NAME = "Unnamed client";
export const MAX_REDIRECT_URIS = 10;
const REDIRECT_URI_MAX = 2000;

// A client_id is 32 random bytes in base64url.
const CLIENT_ID_SHAPE = /^[A-Za-z0-9_-]{43}$/;
// RFC 7636: code_challenge and code_verifier are 43 to 128 unreserved characters.
const PKCE_SHAPE = /^[A-Za-z0-9._~-]{43,128}$/;

// --- URLs and discovery documents --------------------------------------------

/** APP_URL without a trailing slash: the issuer, and the base of every endpoint. */
export function issuer(): string {
  return appUrl().replace(/\/+$/, "");
}

/** The protected resource (RFC 8707): the MCP endpoint. */
export function mcpResource(): string {
  return `${issuer()}/api/mcp`;
}

/** RFC 9728 protected resource metadata. */
export function protectedResourceMetadata() {
  return {
    resource: mcpResource(),
    authorization_servers: [issuer()],
    scopes_supported: [...SUPPORTED_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: APP_NAME,
  };
}

/** RFC 8414 authorization server metadata (also served as openid-configuration). */
export function authorizationServerMetadata() {
  const base = issuer();
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    scopes_supported: [...SUPPORTED_SCOPES],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    // RFC 9207: every authorization response carries iss, so a client talking to
    // several servers can tell which one answered (mix-up attacks).
    authorization_response_iss_parameter_supported: true,
  };
}

/** RFC 8707: whether a `resource` parameter names our MCP endpoint (one trailing slash allowed). */
export function isOurResource(resource: string): boolean {
  return resource.replace(/\/$/, "") === mcpResource();
}

// --- HTTP helpers -------------------------------------------------------------

/** CORS for the machine endpoints: any origin, no credentials (nothing here reads cookies). */
export function corsHeaders(methods: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": methods,
    // MCP clients send MCP-Protocol-Version even on discovery requests.
    "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
    "Access-Control-Max-Age": "86400",
  };
}

/** The answer to a CORS preflight. */
export function preflight(methods: string): Response {
  return new Response(null, { status: 204, headers: corsHeaders(methods) });
}

/** A public, cacheable discovery document. */
export function metadataResponse(document: object): NextResponse {
  return NextResponse.json(document, {
    headers: { ...corsHeaders("GET, OPTIONS"), "Cache-Control": "public, max-age=300" },
  });
}

export type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unsupported_grant_type"
  | "invalid_scope"
  | "invalid_target"
  | "invalid_redirect_uri"
  | "invalid_client_metadata"
  | "server_error"
  | "temporarily_unavailable";

/** RFC 6749 §5.2 / RFC 7591 §3.2.2 error body. The description never contains a submitted secret. */
export function oauthError(
  error: OAuthErrorCode,
  description: string,
  status: number,
  headers: Record<string, string>
): NextResponse {
  return NextResponse.json({ error, error_description: description }, { status, headers });
}

/**
 * Whether the request declares a body larger than `max` bytes in Content-Length,
 * so it can be refused before a byte of it is read. A request without the header
 * (chunked) passes; the route still checks what it actually read.
 */
export function declaresOversizedBody(req: Request, max = OAUTH_BODY_MAX): boolean {
  const declared = Number(req.headers.get("content-length"));
  return Number.isFinite(declared) && declared > max;
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** Where a redirect URI leads, for the user to read: its host, or its scheme for an app link (cursor://). */
export function redirectDestination(redirectUri: string): string {
  const url = new URL(redirectUri);
  return url.protocol === "https:" || url.protocol === "http:" ? url.host : url.protocol.replace(/:$/, "");
}

/**
 * An error response the user may carry back to the client by clicking a link:
 * offered only once the client and its redirect URI checked out, and never
 * followed automatically (RFC 9700 §4.11.2).
 */
export interface ReturnLink {
  /** The redirect URI with error, error_description, state and iss. */
  href: string;
  /** Its host or scheme, for "Return to …". */
  destination: string;
}

/**
 * The page shown for a request this server won't act on: an untrusted
 * redirect target (unknown client, unregistered redirect URI), a request that
 * can't be read, or any other invalid authorization request. `message` is
 * always one of our fixed sentences, never request input. With `returnTo`, the
 * page also offers a plain link back to the client carrying the error; nothing
 * happens until the user clicks it.
 */
export function oauthErrorPage(message: string, status = 400, returnTo: ReturnLink | null = null): Response {
  const back = returnTo
    ? `<p><a href="${escapeHtml(returnTo.href)}" rel="noreferrer">Return to ${escapeHtml(returnTo.destination)}</a></p>\n`
    : "";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Can't connect · ${APP_NAME}</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#09090b;color:#f4f4f5;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:0 24px}
main{max-width:28rem}
h1{font-size:1.5rem;margin:0 0 .75rem}
p{color:#a1a1aa;margin:0 0 .75rem}
.app{text-transform:uppercase;letter-spacing:.08em;font-size:.75rem;color:#71717a}
a{color:#7dd3fc}
</style>
</head>
<body>
<main>
<p class="app">${APP_NAME}</p>
<h1>This connection request can't be completed</h1>
<p>${escapeHtml(message)}</p>
<p>Go back to the app you came from and add the connector again.</p>
${back}</main>
</body>
</html>
`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    },
  });
}

/**
 * `uri` with `params` added through the URL API, so a query string the client
 * registered survives. Null and undefined values are left out.
 */
export function withParams(uri: string, params: Record<string, string | null | undefined>): string {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

// --- Scopes and PKCE ----------------------------------------------------------

/**
 * A space-separated scope parameter as a list: [] when absent or blank, null
 * when it names anything other than read and write. Normalize a non-empty
 * result with normalizeScopes (write implies read).
 */
export function parseScopeParam(raw: string | null | undefined): ApiScope[] | null {
  const parts = (raw ?? "").split(" ").filter(Boolean);
  if (parts.some((part) => part !== "read" && part !== "write")) return null;
  return parts as ApiScope[];
}

/** The `scope` string of a token response: "read" or "read write". */
export function scopeString(scopes: readonly ApiScope[]): string {
  return normalizeScopes([...scopes]).join(" ");
}

export const isPkceValue = (value: string) => PKCE_SHAPE.test(value);

/** S256: base64url(SHA-256(verifier)). */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// --- Clients and redirect URIs ------------------------------------------------

export interface OAuthClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
// Schemes a redirect may never use: script and data URLs, local files, and the
// special schemes that aren't http(s).
const FORBIDDEN_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "blob:", "about:", "ftp:", "ws:", "wss:"]);

/**
 * Why a redirect URI can't be registered, or null when it can: https anywhere;
 * http only on a loopback host (any port); or a custom app scheme such as
 * cursor:// or vscode://. Never a fragment or embedded credentials.
 */
export function redirectUriProblem(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return "Each redirect URI must be a non-empty string";
  if (raw.length > REDIRECT_URI_MAX) return `Redirect URIs can be at most ${REDIRECT_URI_MAX} characters`;
  if (/[\u0000-\u0020\u007f]/.test(raw)) return "Redirect URIs can't contain spaces or control characters";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Each redirect URI must be an absolute URL";
  }
  if (raw.includes("#")) return "Redirect URIs can't contain a fragment";
  if (url.username || url.password) return "Redirect URIs can't contain credentials";
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:") {
    return LOOPBACK_HOSTS.has(url.hostname) ? null : "http redirect URIs are only allowed on localhost, 127.0.0.1 or [::1]";
  }
  if (FORBIDDEN_SCHEMES.has(url.protocol)) return `${url.protocol} redirect URIs aren't allowed`;
  return null;
}

/** An http loopback URI with its port removed, or null for anything else. */
function loopbackWithoutPort(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) return null;
  url.port = "";
  return url.href;
}

/**
 * Whether `requested` is one of the client's registered redirect URIs: exact
 * string match, except that a loopback http URI may use any port (OAuth 2.1
 * §8.4.2, RFC 8252 §7.3: native apps listen on whatever port the OS gives them).
 */
export function redirectUriMatches(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  const wanted = loopbackWithoutPort(requested);
  return wanted !== null && registered.some((uri) => loopbackWithoutPort(uri) === wanted);
}

/**
 * A client-supplied name made safe to show on the consent page: control
 * characters become spaces, invisible formatting characters (bidi overrides,
 * zero-width joiners) go, whitespace collapses, at most 100 characters.
 */
export function sanitizeClientName(raw: unknown): string {
  if (typeof raw !== "string") return DEFAULT_CLIENT_NAME;
  const cleaned = raw
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(cleaned).slice(0, CLIENT_NAME_MAX).join("").trim() || DEFAULT_CLIENT_NAME;
}

/** A fresh client_id: 32 random bytes in base64url. */
export const newClientId = () => randomBytes(32).toString("base64url");

/** The registered client, or null when there is no such client. Throws only when the database can't be asked. */
export async function getClient(clientId: string | null | undefined): Promise<OAuthClient | null> {
  if (!clientId || !CLIENT_ID_SHAPE.test(clientId)) return null; // not one of ours: no lookup
  const { data, error } = await db()
    .from("oauth_clients")
    .select("client_id, client_name, redirect_uris")
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) throw new Error(`Client lookup failed: ${error.message}`);
  if (!data) return null;
  return {
    client_id: String(data.client_id),
    client_name: sanitizeClientName(data.client_name),
    redirect_uris: Array.isArray(data.redirect_uris) ? data.redirect_uris.filter((u: unknown) => typeof u === "string") : [],
  };
}

/** Records that a client just obtained tokens. Bookkeeping only: a failure is logged, never thrown. */
export async function touchClient(clientId: string): Promise<void> {
  const { error } = await db()
    .from("oauth_clients")
    .update({ last_used_at: new Date().toISOString() })
    .eq("client_id", clientId);
  if (error) console.error("oauth: last_used_at update failed for a client:", error.message);
}

// --- The authorization request ------------------------------------------------

/** A validated /oauth/authorize request. */
export interface AuthorizeRequest {
  clientId: string;
  clientName: string;
  redirectUri: string;
  scopes: ApiScope[];
  state: string | null;
  codeChallenge: string;
  resource: string | null;
}

export type AuthorizeErrorCode = "invalid_request" | "unsupported_response_type" | "invalid_scope" | "invalid_target";

export type AuthorizeCheck =
  | { ok: true; request: AuthorizeRequest }
  /**
   * Refused: show an error page with `message`, never redirect. `returnTo` is
   * set only when the client is known and the redirect URI registered: the
   * error response, offered as a link the user may click.
   */
  | { ok: false; message: string; returnTo: ReturnLink | null };

const AUTHORIZE_PARAMS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
  "resource",
];

/**
 * An authorization response for the client (RFC 6749 §4.1.2): `redirectUri`
 * with `params` and, per RFC 9207, `iss`, so the client can check which server
 * answered.
 */
export function authorizationResponseUrl(redirectUri: string, params: Record<string, string | null | undefined>): string {
  return withParams(redirectUri, { ...params, iss: issuer() });
}

/**
 * Checks an authorization request in the order RFC 6749 §4.1.2.1 asks for:
 * client and redirect URI first, then everything else. Nothing fails with a
 * redirect: once the client and redirect URI check out, a failure carries a
 * link back with `error`, `error_description` and `state` for the user to
 * click (RFC 9700 §4.11.2), since anyone can register a client with any
 * redirect URI. Throws only when the database can't be asked.
 */
export async function checkAuthorizeRequest(params: URLSearchParams): Promise<AuthorizeCheck> {
  const clientIds = params.getAll("client_id");
  const redirectUris = params.getAll("redirect_uri");
  if (clientIds.length !== 1 || redirectUris.length !== 1) {
    return { ok: false, message: "The request needs exactly one client_id and one redirect_uri.", returnTo: null };
  }
  const client = await getClient(clientIds[0]);
  if (!client) {
    return { ok: false, message: "The app asking for access isn't registered here.", returnTo: null };
  }
  const redirectUri = redirectUris[0];
  if (!redirectUriMatches(client.redirect_uris, redirectUri)) {
    return { ok: false, message: "The app asked to return to an address it didn't register.", returnTo: null };
  }

  const state = params.get("state");
  // `description` is always our own wording (the only interpolations are a name
  // from AUTHORIZE_PARAMS and our resource URL), so the page may show it.
  const fail = (error: AuthorizeErrorCode, description: string): AuthorizeCheck => ({
    ok: false,
    message: `The app's request can't be accepted: ${description}.`,
    returnTo: {
      href: authorizationResponseUrl(redirectUri, { error, error_description: description, state }),
      destination: redirectDestination(redirectUri),
    },
  });

  const repeated = AUTHORIZE_PARAMS.find((name) => params.getAll(name).length > 1);
  if (repeated) return fail("invalid_request", `${repeated} was sent more than once`);

  const responseType = params.get("response_type");
  if (!responseType) return fail("invalid_request", "response_type is required");
  if (responseType !== "code") return fail("unsupported_response_type", 'only response_type "code" is supported');

  const codeChallenge = params.get("code_challenge");
  if (!codeChallenge) return fail("invalid_request", "code_challenge is required (PKCE)");
  if (!isPkceValue(codeChallenge)) {
    return fail("invalid_request", "code_challenge must be 43 to 128 characters of A-Z, a-z, 0-9, '.', '_', '~' and '-'");
  }
  if (params.get("code_challenge_method") !== "S256") {
    return fail("invalid_request", 'code_challenge_method must be "S256"');
  }

  const requested = parseScopeParam(params.get("scope"));
  if (requested === null) return fail("invalid_scope", 'scope may only contain "read" and "write"');
  const scopes = requested.length > 0 ? normalizeScopes(requested) : (["read"] as ApiScope[]);

  const resource = params.get("resource");
  if (resource !== null && !isOurResource(resource)) {
    return fail("invalid_target", `resource must be ${mcpResource()}`);
  }

  return {
    ok: true,
    request: {
      clientId: client.client_id,
      clientName: client.client_name,
      redirectUri,
      scopes,
      state,
      codeChallenge,
      resource,
    },
  };
}

/** The sign-in URL that comes back to `returnPath` (a path on this app) afterwards. */
export function loginUrl(returnPath: string): string {
  return `${issuer()}/api/auth/login?next=${encodeURIComponent(returnPath)}`;
}

// --- The consent blob ---------------------------------------------------------

/** What the user is approving, bound to who they are and for how long. */
export interface ConsentGrant {
  clientId: string;
  redirectUri: string;
  scopes: ApiScope[];
  state: string | null;
  codeChallenge: string;
  resource: string | null;
  userId: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
}

// Mixed into the HMAC so a consent signature can't stand in for any other
// signature the app makes with the same secret (sessions, the gate cookie).
const CONSENT_PURPOSE = "oauth-consent:v1:";
const CONSENT_MAX_LENGTH = 16 * 1024;

/**
 * The consent form's one hidden field: the validated request and the user,
 * base64url JSON plus an HMAC, valid for ten minutes. A crafted POST can't
 * change what was approved without breaking the signature.
 */
export function sealConsent(request: AuthorizeRequest, userId: string, now = Date.now()): string {
  const grant: ConsentGrant = {
    clientId: request.clientId,
    redirectUri: request.redirectUri,
    scopes: request.scopes,
    state: request.state,
    codeChallenge: request.codeChallenge,
    resource: request.resource,
    userId,
    expiresAt: now + CONSENT_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(grant)).toString("base64url");
  return `${body}.${sign(CONSENT_PURPOSE + body)}`;
}

const isStringOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";

/** The grant inside a consent blob, or null when it is malformed, tampered with or expired. */
export function openConsent(blob: unknown, now = Date.now()): ConsentGrant | null {
  if (typeof blob !== "string" || blob.length > CONSENT_MAX_LENGTH) return null;
  const dot = blob.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = blob.slice(0, dot);
  if (!verifySignature(CONSENT_PURPOSE + body, blob.slice(dot + 1))) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const g = raw as Record<string, unknown>;
  if (
    typeof g.clientId !== "string" ||
    typeof g.redirectUri !== "string" ||
    typeof g.codeChallenge !== "string" ||
    !isPkceValue(g.codeChallenge) ||
    typeof g.userId !== "string" ||
    !g.userId ||
    !isStringOrNull(g.state) ||
    !isStringOrNull(g.resource) ||
    (typeof g.resource === "string" && !isOurResource(g.resource)) ||
    !Array.isArray(g.scopes) ||
    g.scopes.length === 0 ||
    g.scopes.some((s) => s !== "read" && s !== "write") ||
    typeof g.expiresAt !== "number"
  ) {
    return null;
  }
  if (!(g.expiresAt > now)) return null;
  return {
    clientId: g.clientId,
    redirectUri: g.redirectUri,
    scopes: normalizeScopes(g.scopes as ApiScope[]),
    state: g.state,
    codeChallenge: g.codeChallenge,
    resource: g.resource,
    userId: g.userId,
    expiresAt: g.expiresAt,
  };
}

// --- Authorization codes ------------------------------------------------------

/**
 * Stores a five-minute, single-use code for an approved grant and returns it.
 * Only its SHA-256 hex is kept.
 */
export async function issueAuthorizationCode(grant: ConsentGrant): Promise<string> {
  const code = randomBytes(32).toString("base64url");
  const now = Date.now();
  const { error } = await db()
    .from("oauth_codes")
    .insert({
      code_hash: hashToken(code),
      client_id: grant.clientId,
      user_id: grant.userId,
      redirect_uri: grant.redirectUri,
      scopes: normalizeScopes(grant.scopes),
      code_challenge: grant.codeChallenge,
      resource: grant.resource,
      expires_at: new Date(now + CODE_TTL_MS).toISOString(),
      created_at: new Date(now).toISOString(),
    });
  if (error) throw new Error(`Couldn't save the authorization code: ${error.message}`);
  return code;
}

/**
 * Whether a connection last used at `lastUsedAt` has gone REFRESH_IDLE_DAYS
 * without use, so its refresh token no longer works. An unreadable time counts
 * as idle.
 */
export function isRefreshIdle(lastUsedAt: string, now = Date.now()): boolean {
  const last = Date.parse(lastUsedAt);
  return !(now - last < REFRESH_IDLE_DAYS * 24 * 60 * 60 * 1000);
}

/** Whether the user still exists and is still on the allowlist. Throws only when the database can't be asked. */
export async function isUserAllowed(userId: string): Promise<boolean> {
  const { data, error } = await db().from("users").select("is_allowed").eq("id", userId).maybeSingle();
  if (error) throw new Error(`User lookup failed: ${error.message}`);
  return !!data?.is_allowed;
}
