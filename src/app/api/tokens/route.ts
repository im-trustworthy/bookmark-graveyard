import { NextRequest, NextResponse } from "next/server";
import { countActiveApiTokens, listApiTokens, MAX_ACTIVE_TOKENS, mintApiToken } from "@/lib/api-tokens";
import type { ApiScope } from "@/lib/api-tokens";
import { apiError } from "@/lib/errors";
import { getSessionUserId } from "@/lib/session";

// Personal access tokens for the Assistants panel. Session cookie only, on
// purpose: a bearer token is never accepted here, so a leaked token can't mint
// or list tokens. Plaintext tokens appear in exactly one response (the 201
// below) and are never logged.

const NAME_MAX = 60;
const EXPIRY_CHOICE = 90; // the panel's "expires in 90 days"; otherwise no expiry

interface CreateBody {
  name: string;
  scope: ApiScope;
  expiresInDays: number | null;
}

const hasControlChars = (text: string) =>
  Array.from(text).some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);

/** The validated body, or a user-facing message naming the rule that failed (never the submitted value). */
function parseCreateBody(raw: unknown): CreateBody | string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return 'Expected a JSON body like {"name": "Grok", "scope": "read"}';
  }
  const { name, scope, expiresInDays } = raw as Record<string, unknown>;
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed || trimmed.length > NAME_MAX) return `name must be 1 to ${NAME_MAX} characters`;
  if (hasControlChars(trimmed)) return "name can't contain control characters";
  if (scope !== "read" && scope !== "write") return 'scope must be "read" or "write"';
  if (expiresInDays !== undefined && expiresInDays !== null && expiresInDays !== EXPIRY_CHOICE) {
    return `expiresInDays must be ${EXPIRY_CHOICE} or null`;
  }
  return { name: trimmed, scope, expiresInDays: expiresInDays ?? null };
}

// The Assistants panel's list: every token the user made (revoked ones too, with
// revoked_at set; the panel hides them). Never includes hashes.
export async function GET() {
  const context = "GET /api/tokens";
  const userId = await getSessionUserId();
  if (!userId) return apiError(context, "no session", "Not logged in", 401);
  try {
    return NextResponse.json({ tokens: await listApiTokens(userId) });
  } catch (err) {
    return apiError(context, err, "Couldn't load your tokens");
  }
}

// Create a token. `write` tokens can also read; the answer carries the
// plaintext once and the stored record (no hash).
export async function POST(req: NextRequest) {
  const context = "POST /api/tokens";
  const userId = await getSessionUserId();
  if (!userId) return apiError(context, "no session", "Not logged in", 401);

  const body = parseCreateBody(await req.json().catch(() => undefined));
  if (typeof body === "string") return apiError(context, body, body, 400);

  try {
    if ((await countActiveApiTokens(userId)) >= MAX_ACTIVE_TOKENS) {
      const message = `You already have ${MAX_ACTIVE_TOKENS} active tokens. Revoke one before creating another.`;
      return apiError(context, message, message, 400);
    }
    const { token, record } = await mintApiToken(userId, {
      name: body.name,
      scopes: body.scope === "write" ? ["read", "write"] : ["read"],
      expiresInDays: body.expiresInDays,
    });
    return NextResponse.json({ token, record }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return apiError(context, err, "Couldn't create the token");
  }
}
