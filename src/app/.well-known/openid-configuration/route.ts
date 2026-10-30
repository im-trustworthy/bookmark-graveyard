import { authorizationServerMetadata, metadataResponse, preflight } from "@/lib/oauth";

// Some OAuth clients look for the authorization server here before (or instead
// of) /.well-known/oauth-authorization-server. Same document; this app issues
// no ID tokens.

export const dynamic = "force-dynamic";

export function GET() {
  return metadataResponse(authorizationServerMetadata());
}

export function OPTIONS() {
  return preflight("GET, OPTIONS");
}
