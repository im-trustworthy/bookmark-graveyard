import { NextRequest, NextResponse } from "next/server";
import {
  CLIENT_STALE_DAYS,
  CLIENT_UNUSED_MINUTES,
  corsHeaders,
  declaresOversizedBody,
  MAX_CLIENTS,
  MAX_EVICTIONS_PER_REGISTRATION,
  MAX_REDIRECT_URIS,
  newClientId,
  OAUTH_BODY_MAX,
  oauthError,
  preflight,
  redirectUriProblem,
  sanitizeClientName,
} from "@/lib/oauth";
import type { OAuthErrorCode } from "@/lib/oauth";
import { db } from "@/lib/supabase";

// RFC 7591 dynamic client registration, open to anyone (that is the point:
// claude.ai or ChatGPT registers itself the first time a user adds the
// connector). Public clients only: no secret is issued, and the only token
// endpoint auth method is "none"; PKCE is what binds a code to its client.
//
// Abuse guard, built so a flood of registrations can't lock real sign-ups
// out: every registration first prunes registrations that never got a code
// after an hour (and fully revoked ones after 30 days). At MAX_CLIENTS it
// evicts the oldest registration with no live token, a few at most, and
// answers 503 only when there is nothing left that may be evicted, which
// takes a thousand connected clients rather than a script.

const METHODS = "POST, OPTIONS";
const HEADERS = { ...corsHeaders(METHODS), "Cache-Control": "no-store", Pragma: "no-cache" };
const GRANT_TYPES = ["authorization_code", "refresh_token"];

interface Registration {
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
}

const fail = (error: OAuthErrorCode, description: string, status = 400) =>
  oauthError(error, description, status, HEADERS);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** The registration to store, or the RFC 7591 error to answer with. */
function parseRegistration(raw: unknown): Registration | { error: OAuthErrorCode; description: string } {
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
      description: 'token_endpoint_auth_method must be "none": this server only registers public clients (use PKCE)',
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

/**
 * Makes room for one more registration: prunes, then evicts while the table is
 * at the ceiling. False when it is full of clients that may not be evicted.
 */
async function makeRoom(): Promise<boolean> {
  const { data: remaining, error: pruneError } = await db().rpc("prune_oauth_clients", {
    p_unused_minutes: CLIENT_UNUSED_MINUTES,
    p_stale_days: CLIENT_STALE_DAYS,
  });
  if (pruneError) throw new Error(`prune_oauth_clients failed: ${pruneError.message}`);

  let count = Number(remaining);
  for (let evictions = 0; count >= MAX_CLIENTS && evictions < MAX_EVICTIONS_PER_REGISTRATION; evictions++) {
    const { data: evicted, error: evictError } = await db().rpc("evict_oauth_client");
    if (evictError) throw new Error(`evict_oauth_client failed: ${evictError.message}`);
    if (evicted !== true) return false;
    count--;
  }
  // Still at the ceiling after a few evictions (registrations racing this one):
  // register anyway. Each later registration evicts again, so the overshoot is bounded.
  return true;
}

const tooLarge = () => fail("invalid_client_metadata", "The registration request is too large", 413);

export async function POST(req: NextRequest) {
  // Refused before reading a byte when the client says how big it is; the
  // length check after reading covers a body sent without Content-Length.
  if (declaresOversizedBody(req)) return tooLarge();
  const text = await req.text().catch(() => "");
  if (text.length > OAUTH_BODY_MAX) return tooLarge();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail("invalid_client_metadata", "Expected a JSON object with redirect_uris");
  }
  const registration = parseRegistration(raw);
  if ("error" in registration) return fail(registration.error, registration.description);

  try {
    if (!(await makeRoom())) {
      console.error(`POST /oauth/register: refused, ${MAX_CLIENTS} clients are registered and none may be evicted`);
      return fail("temporarily_unavailable", "This server isn't accepting new clients right now. Try again later.", 503);
    }

    const clientId = newClientId();
    const issuedAt = new Date();
    const { error } = await db().from("oauth_clients").insert({
      client_id: clientId,
      client_name: registration.client_name,
      redirect_uris: registration.redirect_uris,
      token_endpoint_auth_method: "none",
      created_at: issuedAt.toISOString(),
    });
    if (error) throw new Error(`Couldn't save the client: ${error.message}`);

    return NextResponse.json(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(issuedAt.getTime() / 1000),
        client_name: registration.client_name,
        redirect_uris: registration.redirect_uris,
        token_endpoint_auth_method: "none",
        grant_types: registration.grant_types,
        response_types: registration.response_types,
      },
      { status: 201, headers: HEADERS }
    );
  } catch (err) {
    console.error("POST /oauth/register:", err);
    return fail("server_error", "Couldn't register the client. Try again later.", 500);
  }
}

export function OPTIONS() {
  return preflight(METHODS);
}
