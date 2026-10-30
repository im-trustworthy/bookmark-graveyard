import { metadataResponse, preflight, protectedResourceMetadata } from "@/lib/oauth";

// RFC 9728 §3.1 path-insertion form for the resource /api/mcp: the same
// document as /.well-known/oauth-protected-resource.

export const dynamic = "force-dynamic";

export function GET() {
  return metadataResponse(protectedResourceMetadata());
}

export function OPTIONS() {
  return preflight("GET, OPTIONS");
}
