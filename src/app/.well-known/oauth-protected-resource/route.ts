import { metadataResponse, preflight, protectedResourceMetadata } from "@/lib/oauth";

// RFC 9728 protected resource metadata for the MCP endpoint: where to get a
// token for it. The MCP route's 401 challenge points here; the same document is
// also served at the path-insertion form, /.well-known/oauth-protected-resource/api/mcp.
// Never behind the password gate: the proxy skips any path with a dot.

// Read APP_URL per request rather than freezing whatever the build saw.
export const dynamic = "force-dynamic";

export function GET() {
  return metadataResponse(protectedResourceMetadata());
}

export function OPTIONS() {
  return preflight("GET, OPTIONS");
}
