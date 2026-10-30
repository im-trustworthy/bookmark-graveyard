import { createMcpHandler, withMcpAuth } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { verifyApiToken } from "@/lib/api-tokens";
import { bearerToken } from "@/lib/auth";
import { appUrl } from "@/lib/env";
import { MCP_INSTRUCTIONS, registerTools } from "@/lib/mcp/tools";
import pkg from "../../../../package.json";

// MCP endpoint: the connector an AI assistant (Grok, Claude, ChatGPT, Cursor, any MCP client) calls to
// search the user's bookmarks, read their briefs and start new ones. It serves MCP statelessly over
// Streamable HTTP through mcp-handler: the 2026-07-28 revision natively and 2025-era clients through the
// SDK's stateless fallback; GET and DELETE answer 405. Auth is a bearer token only, a personal access
// token from the Assistants panel (or one issued through OAuth), checked by verifyApiToken on every request
// so revocation and the allowlist apply at once. This route never reads cookies, so a page open in the
// user's browser can't make it act for them. A missing or unknown token gets 401 with an RFC 9728
// WWW-Authenticate challenge naming the protected resource metadata; scopes are checked per tool
// (src/lib/mcp/tools.ts), so a read-only token reaches the read tools and gets a tool error from the write
// ones. generate_brief and get_brief_status schedule the brief job runner with after() from next/server,
// which needs the request scope this handler runs in: the runner starts once the response is sent and gets
// this route's maxDuration, and on hosts that cut it short a later status poll schedules it again.

export const maxDuration = 300;

const handler = createMcpHandler(registerTools, {
  serverInfo: { name: "bookmark-graveyard", version: pkg.version },
  instructions: MCP_INSTRUCTIONS,
});

/** The token's user as MCP auth info, or undefined (401) without a live token. Ignores cookies. */
async function verify(req: Request): Promise<AuthInfo | undefined> {
  const token = bearerToken(req);
  if (!token) return undefined;
  const verified = await verifyApiToken(token);
  if (!verified) return undefined;
  return {
    token,
    scopes: verified.scopes,
    clientId: verified.tokenId,
    extra: { userId: verified.userId, tokenId: verified.tokenId },
  };
}

// The challenge's resource_metadata comes from APP_URL, the same source the OAuth server uses for its RFC 9728
// document (resource `${appUrl()}/api/mcp`), never from X-Forwarded-* or the request URL: clients compare
// the two against the server URL they connected to. Read once at module load, like the rest of APP_URL's uses.
const authed = withMcpAuth(handler, verify, {
  required: true,
  resourceMetadataPath: "/.well-known/oauth-protected-resource",
  resourceUrl: appUrl().replace(/\/+$/, ""),
});

export { authed as GET, authed as POST, authed as DELETE };
