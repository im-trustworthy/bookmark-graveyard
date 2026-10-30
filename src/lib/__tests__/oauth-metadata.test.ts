import { afterEach, describe, expect, it, vi } from "vitest";
import * as protectedResource from "@/app/.well-known/oauth-protected-resource/route";
import * as protectedResourceForMcp from "@/app/.well-known/oauth-protected-resource/api/mcp/route";
import * as authorizationServer from "@/app/.well-known/oauth-authorization-server/route";
import * as openidConfiguration from "@/app/.well-known/openid-configuration/route";

// The discovery documents MCP clients read before anything else (RFC 9728,
// RFC 8414). Every URL in them comes from APP_URL, never the request.

afterEach(() => {
  vi.unstubAllEnvs();
});

const PROTECTED_RESOURCE = {
  resource: "https://graveyard.example.com/api/mcp",
  authorization_servers: ["https://graveyard.example.com"],
  scopes_supported: ["read", "write"],
  bearer_methods_supported: ["header"],
  resource_name: "Bookmark Graveyard",
};

const AUTHORIZATION_SERVER = {
  issuer: "https://graveyard.example.com",
  authorization_endpoint: "https://graveyard.example.com/oauth/authorize",
  token_endpoint: "https://graveyard.example.com/oauth/token",
  registration_endpoint: "https://graveyard.example.com/oauth/register",
  scopes_supported: ["read", "write"],
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
};

describe.each([
  ["/.well-known/oauth-protected-resource", protectedResource, PROTECTED_RESOURCE],
  ["/.well-known/oauth-protected-resource/api/mcp", protectedResourceForMcp, PROTECTED_RESOURCE],
  ["/.well-known/oauth-authorization-server", authorizationServer, AUTHORIZATION_SERVER],
  ["/.well-known/openid-configuration", openidConfiguration, AUTHORIZATION_SERVER],
])("%s", (_path, route, expected) => {
  it("serves the document from APP_URL, trailing slash dropped, as public cacheable JSON", async () => {
    vi.stubEnv("APP_URL", "https://graveyard.example.com/");
    const res = route.GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await res.json()).toEqual(expected);
  });

  it("answers a CORS preflight, MCP-Protocol-Version included", () => {
    const res = route.OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
    expect(res.headers.get("access-control-allow-headers")).toMatch(/MCP-Protocol-Version/);
  });

  it("is rendered per request, so a runtime APP_URL wins over the build's", () => {
    expect(route.dynamic).toBe("force-dynamic");
  });
});

it("serves the same protected resource document at both paths", async () => {
  expect(await protectedResource.GET().json()).toEqual(await protectedResourceForMcp.GET().json());
  expect(await authorizationServer.GET().json()).toEqual(await openidConfiguration.GET().json());
});

it("falls back to the local default without APP_URL", async () => {
  vi.stubEnv("APP_URL", undefined);
  expect(await protectedResource.GET().json()).toMatchObject({
    resource: "http://localhost:3000/api/mcp",
    authorization_servers: ["http://localhost:3000"],
  });
});
