import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { createFakeDb } from "./fake-db";
import type { FakeDb } from "./fake-db";

// The real /api/mcp route handler, driven in-process with the JSON-RPC requests a Streamable HTTP client
// sends, over both protocol generations mcp-handler serves: 2025-era (initialize, then plain requests,
// answered over SSE) and 2026-07-28 (a per-request _meta envelope plus Mcp-Method/Mcp-Name headers,
// answered as JSON). Auth is a token minted into the fake db. The session cookie is mocked to a signed-in
// user throughout, to show the route never looks at it.
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase", () => ({ db: () => state.db }));
vi.mock("@/lib/session", () => ({ getSessionUserId: async () => "u1" }));

import { DELETE, GET, POST } from "@/app/api/mcp/route";
import { mintApiToken } from "@/lib/api-tokens";
import pkg from "../../../package.json";

const URL_ = "http://localhost/api/mcp";
const LEGACY = "2025-06-18";
const MODERN = "2026-07-28";
const TOOL_NAMES = [
  "search_bookmarks",
  "list_topics",
  "list_episodes",
  "get_episode",
  "generate_brief",
  "get_brief_status",
  "hide_bookmark",
];

let fake: FakeDb;
let readToken: string;
let nextId = 1;

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return POST(
    new Request(URL_, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify(body),
    })
  );
}

/** The JSON-RPC message in a response, whether it came as JSON or as an SSE event. */
async function message(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) return JSON.parse(text);
  const data = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  expect(data).toHaveLength(1);
  return JSON.parse(data[0]);
}

/** A 2025-era request: no envelope, the negotiated version in MCP-Protocol-Version. */
async function legacy(method: string, params: Record<string, unknown>, token = readToken) {
  const res = await post(
    { jsonrpc: "2.0", id: nextId++, method, params },
    { authorization: `Bearer ${token}`, "mcp-protocol-version": LEGACY }
  );
  expect(res.status).toBe(200);
  return (await message(res)).result as Record<string, unknown>;
}

/** A 2026-07-28 request: the per-request _meta envelope plus the method (and tool name) headers. */
async function modern(method: string, params: Record<string, unknown>, token = readToken) {
  const _meta = {
    [PROTOCOL_VERSION_META_KEY]: MODERN,
    [CLIENT_INFO_META_KEY]: { name: "test-client", version: "1.0.0" },
    [CLIENT_CAPABILITIES_META_KEY]: {},
  };
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "mcp-protocol-version": MODERN,
    "mcp-method": method,
  };
  if (typeof params.name === "string") headers["mcp-name"] = params.name;
  const res = await post({ jsonrpc: "2.0", id: nextId++, method, params: { ...params, _meta } }, headers);
  expect(res.status).toBe(200);
  return (await message(res)).result as Record<string, unknown>;
}

beforeEach(async () => {
  fake = createFakeDb({
    users: [
      { id: "u1", is_allowed: true },
      { id: "u2", is_allowed: true },
    ],
    api_tokens: [],
    bookmarks: [
      {
        user_id: "u1",
        tweet_id: "1",
        author_handle: "ada",
        author_name: "Ada",
        text: "MCP servers are neat",
        tweet_created_at: "2026-10-05T00:00:00Z",
        first_seen_at: "2026-10-06T00:00:00Z",
        public_metrics: null,
        hidden: false,
        bookmark_analysis: { topics: ["mcp"], summary: null, content_type: "news", credibility: "none", claims: [] },
      },
      {
        user_id: "u2",
        tweet_id: "2",
        author_handle: "bob",
        author_name: "Bob",
        text: "Bob's MCP post",
        tweet_created_at: "2026-10-05T00:00:00Z",
        first_seen_at: "2026-10-06T00:00:00Z",
        public_metrics: null,
        hidden: false,
        bookmark_analysis: { topics: ["bob"], summary: null, content_type: "news", credibility: "none", claims: [] },
      },
    ],
  });
  fake.functions.record_usage = vi.fn(() => true);
  state.db = fake;
  readToken = (await mintApiToken("u1", { name: "Grok", scopes: ["read"] })).token;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/mcp, 2025-era client", () => {
  it("initializes, lists the seven tools and calls one as the token's user", async () => {
    const init = await legacy("initialize", {
      protocolVersion: LEGACY,
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    });
    expect(init.serverInfo).toEqual({ name: "bookmark-graveyard", version: pkg.version });
    expect(String(init.instructions)).toMatch(/generate_brief is the only tool that costs money/);

    const { tools } = (await legacy("tools/list", {})) as { tools: { name: string; annotations: unknown }[] };
    expect(tools.map((t) => t.name)).toEqual(TOOL_NAMES);
    expect(tools.find((t) => t.name === "list_topics")?.annotations).toMatchObject({ readOnlyHint: true });

    const result = await legacy("tools/call", { name: "search_bookmarks", arguments: { query: "mcp" } });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { items: { tweet_id: string }[]; total_matches: number };
    // u1's token sees u1's post and not u2's, though both match.
    expect(structured.items.map((i) => i.tweet_id)).toEqual(["1"]);
    expect(structured.total_matches).toBe(1);
    expect(fake.functions.record_usage).toHaveBeenCalledWith(expect.objectContaining({ p_user_id: "u1", p_kind: "mcp_call" }));
  });

  it("answers a write tool called with a read-only token with a tool error, not an HTTP error", async () => {
    const result = await legacy("tools/call", { name: "hide_bookmark", arguments: { tweet_id: "1" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/read-only/);
    expect(fake.tables.bookmarks[0].hidden).toBe(false);
  });

  it("lets a write token hide a bookmark", async () => {
    const writeToken = (await mintApiToken("u1", { name: "Grok rw", scopes: ["write"] })).token;
    const result = await legacy("tools/call", { name: "hide_bookmark", arguments: { tweet_id: "1" } }, writeToken);
    expect(result.structuredContent).toEqual({ ok: true });
    expect(fake.tables.bookmarks[0].hidden).toBe(true);
  });
});

describe("POST /api/mcp, 2026-07-28 client", () => {
  it("lists the tools and returns structuredContent from a call, as JSON", async () => {
    const { tools } = (await modern("tools/list", {})) as { tools: { name: string }[] };
    expect(tools.map((t) => t.name)).toEqual(TOOL_NAMES);

    const result = await modern("tools/call", { name: "list_topics", arguments: {} });
    expect(result.structuredContent).toEqual({ topics: [{ name: "mcp", count: 1 }], library: 1, total: 1 });
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(result.structuredContent, null, 2) }]);
  });
});

describe("auth", () => {
  const listTools = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

  it("answers no token with 401 and a challenge pointing at the protected resource metadata", async () => {
    const res = await post(listTools, { "mcp-protocol-version": LEGACY });
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain('resource_metadata="http://localhost/.well-known/oauth-protected-resource"');
  });

  it("ignores the session cookie: a signed-in browser without a bearer token still gets 401", async () => {
    const res = await post(listTools, { cookie: "bb_session=a-valid-looking-session", "mcp-protocol-version": LEGACY });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("answers an unknown, revoked or malformed token with 401", async () => {
    const revoked = await mintApiToken("u1", { name: "old", scopes: ["write"] });
    fake.tables.api_tokens.find((r) => r.id === revoked.record.id)!.revoked_at = new Date().toISOString();
    for (const token of [`bg_${"x".repeat(43)}`, revoked.token, "not-a-token"]) {
      const res = await post(listTools, { authorization: `Bearer ${token}`, "mcp-protocol-version": LEGACY });
      expect(res.status, token).toBe(401);
    }
  });

  it("answers 405 to GET and DELETE, as a stateless server does", async () => {
    const headers = { authorization: `Bearer ${readToken}` };
    expect((await GET(new Request(URL_, { headers }))).status).toBe(405);
    expect((await DELETE(new Request(URL_, { method: "DELETE", headers }))).status).toBe(405);
  });

  it("never writes the token to the log", async () => {
    const logged: unknown[] = [];
    for (const level of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(...args));
    }
    delete fake.functions.record_usage; // make the tool call fail, which logs
    await legacy("tools/call", { name: "list_topics", arguments: {} });
    expect(logged.length).toBeGreaterThan(0);
    expect(JSON.stringify(logged.map(String))).not.toContain(readToken);
  });
});
