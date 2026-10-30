import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { hashToken, normalizeScopes } from "./api-tokens";
import type { ApiScope } from "./api-tokens";
import { sign, verifySignature } from "./crypto";
import { appUrl } from "./env";
import { checkPublicHost, isReservedHostname } from "./ssrf";
import { db } from "./supabase";

// The app as a small OAuth 2.1 authorization server for its own tokens, so web
// chat products (claude.ai, ChatGPT, grok.com connectors, the MCP Inspector)
// can connect without a pasted token:
//
//   1. The client reads /.well-known/oauth-protected-resource (RFC 9728) and
//      /.well-known/oauth-authorization-server (RFC 8414).
//   2. It registers at POST /oauth/register (RFC 7591): public clients only.
//      Or it skips registering and uses the https URL of its client metadata
//      document as its client_id (CIMD, draft-ietf-oauth-client-id-metadata-
//      document): the server fetches that document, under an SSRF guard, to
//      learn the client's name and redirect URIs.
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
    // A client may use the https URL of its metadata document as client_id
    // instead of registering. With "none" above, this is what claude.ai checks.
    client_id_metadata_document_supported: true,
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
  /**
   * For a client whose client_id is the URL of its metadata document, that
   * URL's host: the site that published the name. Null for a client
   * registered here.
   */
  host: string | null;
}

/** How to name a client to the user: its name, plus the publishing host for a metadata-document client. */
export function clientLabel(client: Pick<OAuthClient, "client_name" | "host">): string {
  return client.host ? `${client.client_name} (${client.host})` : client.client_name;
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

/** Whether a redirect URI leads to a program on the user's own machine (http on a loopback host). */
export const isLoopbackRedirect = (uri: string) => loopbackWithoutPort(uri) !== null;

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

/**
 * The client's oauth_clients row, or null when there is none: a client that
 * registered here, or one known by its metadata document URL that a user has
 * approved (see findClient, which the authorization request uses instead).
 * The token endpoint asks this, so it never fetches anything. Throws only when
 * the database can't be asked.
 */
export async function getClient(clientId: string | null | undefined): Promise<OAuthClient | null> {
  if (!clientId) return null;
  const byUrl = isUrlClientId(clientId);
  // Not one of ours: no lookup.
  if (byUrl ? clientIdUrlProblem(clientId) !== null : !CLIENT_ID_SHAPE.test(clientId)) return null;
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
    host: byUrl ? new URL(clientId).host : null,
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

/** Client metadata (RFC 7591 §2) that passed the checks both registration and metadata documents apply. */
export interface ClientMetadata {
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
}

const GRANT_TYPES = ["authorization_code", "refresh_token"];

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * Client metadata from a registration request or a client metadata document,
 * checked the same way for both: 1 to MAX_REDIRECT_URIS redirect URIs under
 * the redirect rules, a public client (token_endpoint_auth_method "none" or
 * absent), only the code flow and refresh. Otherwise the RFC 7591 error to
 * answer with; `description` is always our own wording.
 */
export function parseClientMetadata(raw: unknown): ClientMetadata | { error: OAuthErrorCode; description: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "invalid_client_metadata", description: "Expected a JSON object with redirect_uris" };
  }
  const body = raw as Record<string, unknown>;

  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > MAX_REDIRECT_URIS) {
    return {
      error: "invalid_redirect_uri",
      description: `redirect_uris must be a list of 1 to ${MAX_REDIRECT_URIS} absolute URLs`,
    };
  }
  for (const uri of uris) {
    const problem = redirectUriProblem(uri);
    if (problem) return { error: "invalid_redirect_uri", description: problem };
  }

  const method = body.token_endpoint_auth_method;
  if (method !== undefined && method !== null && method !== "none") {
    return {
      error: "invalid_client_metadata",
      description: 'token_endpoint_auth_method must be "none": this server only accepts public clients (use PKCE)',
    };
  }

  let grantTypes = GRANT_TYPES;
  if (body.grant_types !== undefined && body.grant_types !== null) {
    if (!isStringArray(body.grant_types) || body.grant_types.some((g) => !GRANT_TYPES.includes(g))) {
      return {
        error: "invalid_client_metadata",
        description: 'grant_types may only contain "authorization_code" and "refresh_token"',
      };
    }
    grantTypes = [...new Set(body.grant_types)];
  }

  if (body.response_types !== undefined && body.response_types !== null) {
    if (!isStringArray(body.response_types) || body.response_types.some((r) => r !== "code")) {
      return { error: "invalid_client_metadata", description: 'response_types may only contain "code"' };
    }
  }

  if (body.scope !== undefined && body.scope !== null && typeof body.scope !== "string") {
    return { error: "invalid_client_metadata", description: "scope must be a space-separated string" };
  }
  if (body.client_name !== undefined && body.client_name !== null && typeof body.client_name !== "string") {
    return { error: "invalid_client_metadata", description: "client_name must be a string" };
  }

  return {
    client_name: sanitizeClientName(body.client_name),
    redirect_uris: [...new Set(uris as string[])],
    grant_types: grantTypes,
    response_types: ["code"],
  };
}

// --- Client ID Metadata Documents ---------------------------------------------
//
// draft-ietf-oauth-client-id-metadata-document, which the MCP authorization
// spec adopts: a client may skip registration and send the https URL of a
// JSON document about itself as its client_id. The authorization request
// (authorize, the consent page, the decision) reads the client from that
// document, fetched under the SSRF guard in ssrf.ts and cached in memory for
// five minutes, so a changed document takes effect at the next sign-in. When
// the user approves, the client gets an ordinary oauth_clients row keyed by
// the URL (rememberMetadataClient): oauth_codes references that table, and the
// token endpoint, revocation and pruning then treat it like any registered
// client without fetching anything.

/** How long a validated client metadata document is used before it is fetched again. */
export const CLIENT_METADATA_TTL_MS = 5 * 60 * 1000;
/** The most of a client metadata document that is read: the draft's recommended limit (§5). */
export const CLIENT_METADATA_MAX_BYTES = 5 * 1024;
/** How long fetching one may take, DNS included. */
export const CLIENT_METADATA_TIMEOUT_MS = 5000;
/** At most this many documents are cached; a new one pushes out the oldest. */
const CLIENT_METADATA_CACHE_MAX = 500;

/** Why a client metadata document can't be used, in our own words for the error page. Never request input. */
export const METADATA_PROBLEMS = {
  url: "The app's client ID is a web address this server can't use: it must be an https address with a path, and no fragment, user name or dot segments.",
  privateHost: "The app's client ID points to a private or local network address, which this server won't fetch.",
  unresolvable: "The app's client ID points to a host that doesn't exist.",
  unreachable: "The app's client metadata document couldn't be fetched from its client ID address.",
  timeout: `The app's client metadata document didn't arrive within ${CLIENT_METADATA_TIMEOUT_MS / 1000} seconds.`,
  status: "The app's client ID address answered with an error instead of its client metadata document.",
  redirect: "The app's client ID address redirected elsewhere; its client metadata document must be served there directly.",
  tooLarge: `The app's client metadata document is larger than ${CLIENT_METADATA_MAX_BYTES / 1024} KB.`,
  notJson: "The app's client metadata document isn't a JSON object.",
  clientIdMismatch: "The app's client metadata document names a different client_id than the address it came from.",
  secret: "The app's client metadata document includes a client secret; this server only accepts public clients.",
  noName: "The app's client metadata document has no client_name.",
  invalid: (description: string) => `The app's client metadata document is invalid: ${description}.`,
} as const;

/** Whether a client_id is a URL (scheme and colon) rather than an id this server issued, which never has a colon. */
export const isUrlClientId = (clientId: string) => /^[A-Za-z][A-Za-z0-9+.-]*:/.test(clientId);

/**
 * Why a URL client_id can't name a metadata document, or null when it can:
 * https; already in the form the URL parser gives it, which rules out dot
 * segments, a default port, an upper-case host and a missing path (the
 * document's client_id must match it character for character); no fragment
 * or user name; and a host that isn't private or local by its text alone. The
 * addresses it resolves to are checked when the document is fetched.
 */
export function clientIdUrlProblem(raw: string): string | null {
  if (raw.length > REDIRECT_URI_MAX || /[\u0000- \u007f]/.test(raw)) return METADATA_PROBLEMS.url;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return METADATA_PROBLEMS.url;
  }
  if (url.protocol !== "https:" || url.href !== raw || url.hash || raw.includes("#") || url.username || url.password) {
    return METADATA_PROBLEMS.url;
  }
  if (isReservedHostname(url.hostname)) return METADATA_PROBLEMS.privateHost;
  return null;
}

type MetadataResult = { client: OAuthClient } | { problem: string };

/**
 * The client a fetched metadata document describes, or why it can't be used.
 * The document is untrusted: its client_id must equal the URL it came from
 * exactly; it may carry no client secret; it must name the client; and the
 * rest goes through parseClientMetadata like a registration, so the name is
 * sanitized and capped and every redirect URI follows the usual rules.
 */
export function clientFromMetadataDocument(clientId: string, raw: unknown): MetadataResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { problem: METADATA_PROBLEMS.notJson };
  const doc = raw as Record<string, unknown>;
  if (doc.client_id !== clientId) return { problem: METADATA_PROBLEMS.clientIdMismatch };
  if (doc.client_secret !== undefined || doc.client_secret_expires_at !== undefined) {
    return { problem: METADATA_PROBLEMS.secret };
  }
  if (typeof doc.client_name !== "string") return { problem: METADATA_PROBLEMS.noName };
  const metadata = parseClientMetadata(doc);
  if ("error" in metadata) return { problem: METADATA_PROBLEMS.invalid(metadata.description) };
  return {
    client: {
      client_id: clientId,
      client_name: metadata.client_name,
      redirect_uris: metadata.redirect_uris,
      host: new URL(clientId).host,
    },
  };
}

/** `promise`, or a rejection as soon as `signal` aborts (dns.lookup itself can't be cancelled). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    promise.then(resolve, reject);
  });
}

/** The body as text, or null once it passes `max` bytes (declared or actually read); stops reading there. */
async function readCapped(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * Fetches and checks the metadata document at `clientId`, a URL that passed
 * clientIdUrlProblem: every address the host resolves to must be public; one
 * GET with Accept: application/json, never cached by Next and never following
 * a redirect; only a 200 counts; at most CLIENT_METADATA_MAX_BYTES read; all
 * within CLIENT_METADATA_TIMEOUT_MS.
 */
async function fetchMetadataDocument(clientId: string): Promise<MetadataResult> {
  const url = new URL(clientId);
  const signal = AbortSignal.timeout(CLIENT_METADATA_TIMEOUT_MS);
  try {
    const host = await untilAborted(checkPublicHost(url.hostname), signal);
    if (host === "special-use") return { problem: METADATA_PROBLEMS.privateHost };
    if (host === "unresolvable") return { problem: METADATA_PROBLEMS.unresolvable };

    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      redirect: "manual",
      cache: "no-store",
      signal,
    });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      return { problem: res.status >= 300 && res.status < 400 ? METADATA_PROBLEMS.redirect : METADATA_PROBLEMS.status };
    }
    const text = await readCapped(res, CLIENT_METADATA_MAX_BYTES);
    if (text === null) return { problem: METADATA_PROBLEMS.tooLarge };
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { problem: METADATA_PROBLEMS.notJson };
    }
    return clientFromMetadataDocument(clientId, raw);
  } catch (err) {
    const timedOut = signal.aborted || (err as { name?: unknown } | null)?.name === "TimeoutError";
    return { problem: timedOut ? METADATA_PROBLEMS.timeout : METADATA_PROBLEMS.unreachable };
  }
}

interface CachedClient {
  client: OAuthClient;
  expiresAt: number;
}

// On globalThis, so that the authorize route, the consent page and the
// decision route share one cache even if they were bundled separately.
const CACHE_KEY = Symbol.for("bookmark-graveyard.oauth.client-metadata");

function metadataCache(): Map<string, CachedClient> {
  const store = globalThis as typeof globalThis & { [CACHE_KEY]?: Map<string, CachedClient> };
  return (store[CACHE_KEY] ??= new Map());
}

/** Empties the client metadata cache. For tests. */
export function forgetClientMetadata(): void {
  metadataCache().clear();
}

/**
 * The client an authorization request names, as `client`, or null when there
 * is none. A registered client comes from oauth_clients. A URL client_id comes
 * from its metadata document, never from the row an earlier approval wrote,
 * so the redirect URIs it lists now are the ones that count: from the cache
 * when it was validated in the last five minutes, otherwise fetched. Only a
 * valid document is cached. `problem` says, in our own words, why a URL
 * client_id or its document can't be used. Throws only when the database
 * can't be asked.
 */
export async function findClient(clientId: string): Promise<{ client: OAuthClient | null; problem: string | null }> {
  if (!isUrlClientId(clientId)) return { client: await getClient(clientId), problem: null };
  const urlProblem = clientIdUrlProblem(clientId);
  if (urlProblem) return { client: null, problem: urlProblem };

  const cache = metadataCache();
  const cached = cache.get(clientId);
  if (cached && cached.expiresAt > Date.now()) return { client: cached.client, problem: null };
  cache.delete(clientId);

  const result = await fetchMetadataDocument(clientId);
  if ("problem" in result) return { client: null, problem: result.problem };
  cache.set(clientId, { client: result.client, expiresAt: Date.now() + CLIENT_METADATA_TTL_MS });
  // Maps iterate in insertion order: the first key is the oldest entry.
  while (cache.size > CLIENT_METADATA_CACHE_MAX) cache.delete(cache.keys().next().value!);
  return { client: result.client, problem: null };
}

/**
 * Writes, or refreshes, the oauth_clients row of a client known by its
 * metadata document, just before its code is stored: oauth_codes references
 * oauth_clients, and the token endpoint, revokeClientTokens and pruning then
 * work from the row as for any registered client. Only an approval by a
 * signed-in, allowed user gets here, so these rows can't be flooded. Throws
 * when the row can't be saved.
 */
export async function rememberMetadataClient(client: OAuthClient): Promise<void> {
  const { error } = await db()
    .from("oauth_clients")
    .upsert(
      {
        client_id: client.client_id,
        client_name: client.client_name,
        redirect_uris: [...client.redirect_uris],
        token_endpoint_auth_method: "none",
      },
      { onConflict: "client_id" }
    );
  if (error) throw new Error(`Couldn't save the client: ${error.message}`);
}

// --- The authorization request ------------------------------------------------

/** A validated /oauth/authorize request. */
export interface AuthorizeRequest {
  clientId: string;
  clientName: string;
  /** The host that published the client's metadata document, or null for a registered client. */
  clientHost: string | null;
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
 * client and redirect URI first (a URL client_id is read from its metadata
 * document, see findClient), then everything else. Nothing fails with a
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
  const { client, problem } = await findClient(clientIds[0]);
  if (!client) {
    return { ok: false, message: problem ?? "The app asking for access isn't registered here.", returnTo: null };
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
      clientHost: client.host,
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
