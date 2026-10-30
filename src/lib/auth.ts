import "server-only";
import { hasScope, verifyApiToken } from "./api-tokens";
import type { ApiScope } from "./api-tokens";
import { getSessionUserId } from "./session";

// Who is calling a route: the dashboard's session cookie, or an assistant's
// personal access token in `Authorization: Bearer …`. Routes that may be
// called from outside the browser use getUserIdFromRequest; the MCP endpoint
// uses getBearerUser, which never looks at cookies, so a page in the user's
// browser can't make it act on their behalf. Token management (/api/tokens)
// uses neither: it is cookie-only, so a token can't mint more tokens.

export interface RequestAuth {
  userId: string;
  via: "cookie" | "token";
  scopes: ApiScope[];
  /** Set when the caller used a token. */
  tokenId?: string;
}

/** The token in an `Authorization: Bearer …` header (scheme case-insensitive), or null. */
export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  const match = header?.match(/^\s*bearer\s+(\S.*)$/i);
  const token = match?.[1].trim();
  return token ? token : null;
}

/** The token's user, if the request carries a live token with `scope`. Ignores cookies entirely. */
export async function getBearerUser(req: Request, scope: ApiScope): Promise<RequestAuth | null> {
  const token = bearerToken(req);
  if (!token) return null;
  const verified = await verifyApiToken(token);
  if (!verified || !hasScope(verified.scopes, scope)) return null;
  return { userId: verified.userId, via: "token", scopes: verified.scopes, tokenId: verified.tokenId };
}

/**
 * The session cookie's user (who may do anything, so both scopes), else the
 * bearer token's user when the token has `scope`. Null when neither applies.
 */
export async function getUserIdFromRequest(req: Request, opts: { scope: ApiScope }): Promise<RequestAuth | null> {
  const sessionUserId = await getSessionUserId();
  if (sessionUserId) return { userId: sessionUserId, via: "cookie", scopes: ["read", "write"] };
  return getBearerUser(req, opts.scope);
}
