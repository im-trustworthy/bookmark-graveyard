import { NextRequest, NextResponse } from "next/server";
import { revokeApiToken } from "@/lib/api-tokens";
import { apiError } from "@/lib/errors";
import { getSessionUserId } from "@/lib/session";

// Revoke one of your own tokens. Session cookie only, like /api/tokens: a
// bearer token is never accepted. The token stops working on its next request.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const context = "DELETE /api/tokens/[id]";
  const userId = await getSessionUserId();
  if (!userId) return apiError(context, "no session", "Not logged in", 401);

  const { id } = await params;
  // Not a uuid can't be a token id; answering 404 here also keeps a malformed id from reaching Postgres.
  if (!UUID_RE.test(id)) return apiError(context, "malformed token id", "Token not found", 404);

  try {
    // Someone else's token, an already revoked one and a made-up id all look the same: not found.
    if (!(await revokeApiToken(userId, id))) return apiError(context, "no live token with that id", "Token not found", 404);
    return NextResponse.json({ revoked: true });
  } catch (err) {
    return apiError(context, err, "Couldn't revoke the token");
  }
}
