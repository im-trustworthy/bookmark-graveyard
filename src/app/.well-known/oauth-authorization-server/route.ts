import { authorizationServerMetadata, metadataResponse, preflight } from "@/lib/oauth";

// RFC 8414 authorization server metadata: the endpoints, PKCE S256 only,
// public clients only. The same document is served at
// /.well-known/openid-configuration, which some clients try first.

// Read APP_URL per request rather than freezing whatever the build saw.
export const dynamic = "force-dynamic";

export function GET() {
  return metadataResponse(authorizationServerMetadata());
}

export function OPTIONS() {
  return preflight("GET, OPTIONS");
}
