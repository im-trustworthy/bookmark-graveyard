import { NextRequest, NextResponse } from "next/server";
import {
  CLIENT_STALE_DAYS,
  CLIENT_UNUSED_MINUTES,
  corsHeaders,
  declaresOversizedBody,
  MAX_CLIENTS,
  MAX_EVICTIONS_PER_REGISTRATION,
  newClientId,
  OAUTH_BODY_MAX,
  oauthError,
  parseClientMetadata,
  preflight,
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

const fail = (error: OAuthErrorCode, description: string, status = 400) =>
  oauthError(error, description, status, HEADERS);

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
  const registration = parseClientMetadata(raw);
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
