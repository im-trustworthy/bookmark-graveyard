import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { createFakeDb } from "./fake-db";
import type { FakeDb } from "./fake-db";
import {
  APP,
  authorizeQuery,
  formPost,
  locationOf,
  oauthTables,
  pkcePair,
  REDIRECT,
  RESOURCE,
  sha256Hex,
  USER_ID,
} from "./oauth-fixtures";

const state = vi.hoisted(() => ({
  db: null as unknown,
  userId: null as string | null,
  lookup: null as unknown as (host: string, options: unknown) => Promise<{ address: string; family: number }[]>,
}));
vi.mock("@/lib/session", () => ({ getSessionUserId: async () => state.userId }));
vi.mock("@/lib/supabase", () => ({ db: () => state.db }));
vi.mock("node:dns/promises", () => ({ lookup: (host: string, options: unknown) => state.lookup(host, options) }));

import { GET as authorizeRoute } from "@/app/oauth/authorize/route";
import ConsentPage from "@/app/oauth/authorize/consent/page";
import { POST as decisionRoute } from "@/app/api/oauth/decision/route";
import { POST as tokenRoute } from "@/app/oauth/token/route";
import {
  CLIENT_METADATA_MAX_BYTES,
  clientFromMetadataDocument,
  clientIdUrlProblem,
  findClient,
  forgetClientMetadata,
  getClient,
  METADATA_PROBLEMS,
} from "@/lib/oauth";

// Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document):
// a client_id that is the https URL of a JSON document about the client. The
// document is fetched under the SSRF guard, validated as untrusted input,
// cached for five minutes, and becomes an oauth_clients row only when the
// user approves. DNS and fetch are mocked; nothing here touches the network.

const T0 = new Date("2026-10-29T12:00:00.000Z");
const MINUTE = 60 * 1000;
const DOC_URL = "https://client.example.com/oauth/metadata.json";
const PUBLIC_ADDRESS = "151.101.1.1";

const doc = (overrides: Record<string, unknown> = {}) => ({
  client_id: DOC_URL,
  client_name: "Claude",
  client_uri: "https://client.example.com",
  redirect_uris: [REDIRECT, "http://localhost/callback", "http://127.0.0.1/callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
  ...overrides,
});

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });

let fake: FakeDb;
let fetchMock: ReturnType<typeof vi.fn>;
let lookupMock: ReturnType<typeof vi.fn>;

/** Every fetch answers with `make()`, a fresh Response each time. */
const serve = (make: () => Response | Promise<Response>) => fetchMock.mockImplementation(async () => make());

const authorize = (query: URLSearchParams) => authorizeRoute(new NextRequest(`${APP}/oauth/authorize?${query}`));

async function renderConsent(query: URLSearchParams): Promise<string> {
  const searchParams: Record<string, string> = {};
  for (const [key, value] of query) searchParams[key] = value;
  return renderToStaticMarkup(await ConsentPage({ searchParams: Promise.resolve(searchParams) }));
}

const consentField = (html: string) => html.match(/name="consent" value="([^"]+)"/)?.[1] ?? null;
const decodeHtml = (text: string) =>
  text.replace(/&(amp|quot|lt|gt|#39|#x27);/g, (_, name: string) => ({ amp: "&", quot: '"', lt: "<", gt: ">", "#39": "'", "#x27": "'" })[name]!);

const decide = (consent: string, decision: string) =>
  decisionRoute(formPost(`${APP}/api/oauth/decision`, { consent, decision }, { Origin: APP }));

const token = (fields: Record<string, string>) => tokenRoute(formPost(`${APP}/oauth/token`, fields));

/** authorize → consent page → approve, for the document client: the code and its verifier. */
async function approve(redirectUri = REDIRECT): Promise<{ code: string; verifier: string }> {
  const { verifier, challenge } = pkcePair();
  const query = authorizeQuery({ client_id: DOC_URL, redirect_uri: redirectUri }, challenge);
  expect((await authorize(query)).status).toBe(302);
  const blob = consentField(await renderConsent(query));
  expect(blob).not.toBeNull();
  const res = await decide(blob!, "approve");
  expect(res.status).toBe(303);
  return { code: locationOf(res).searchParams.get("code")!, verifier };
}

const exchange = (code: string, verifier: string) =>
  token({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: DOC_URL,
    code_verifier: verifier,
    resource: RESOURCE,
  });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  fake = createFakeDb(oauthTables());
  state.db = fake;
  state.userId = USER_ID;
  lookupMock = vi.fn(async () => [{ address: PUBLIC_ADDRESS, family: 4 }]);
  state.lookup = lookupMock as typeof state.lookup;
  fetchMock = vi.fn();
  serve(() => json(doc()));
  vi.stubGlobal("fetch", fetchMock);
  forgetClientMetadata();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("clientIdUrlProblem: which URLs may name a metadata document", () => {
  it.each([
    DOC_URL,
    "https://claude.ai/oauth/claude-code-client-metadata",
    "https://client.example.com/",
    "https://client.example.com:8443/metadata.json",
    "https://client.example.com/metadata.json?v=2",
  ])("accepts %s", (url) => {
    expect(clientIdUrlProblem(url)).toBeNull();
  });

  it.each([
    ["http, not https", "http://client.example.com/oauth/metadata.json"],
    ["no path at all", "https://client.example.com"],
    ["a dot segment", "https://client.example.com/oauth/../metadata.json"],
    ["an encoded dot segment", "https://client.example.com/oauth/%2e%2e/metadata.json"],
    ["a fragment", `${DOC_URL}#x`],
    ["an empty fragment", `${DOC_URL}#`],
    ["credentials", "https://user:pw@client.example.com/oauth/metadata.json"],
    ["an upper-case host", "https://Client.example.com/oauth/metadata.json"],
    ["the default port spelled out", "https://client.example.com:443/oauth/metadata.json"],
    ["a space", "https://client.example.com/oauth/meta data.json"],
    ["another scheme", "javascript:alert(1)"],
    ["something too long", `https://client.example.com/${"a".repeat(2000)}`],
  ])("refuses %s", (_label, url) => {
    expect(clientIdUrlProblem(url)).toBe(METADATA_PROBLEMS.url);
  });

  it.each([
    "https://127.0.0.1/metadata.json",
    "https://10.0.0.8/metadata.json",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/metadata.json",
    "https://[fd00::1]/metadata.json",
    "https://[::ffff:7f00:1]/metadata.json",
    "https://localhost/metadata.json",
    "https://app.localhost/metadata.json",
    "https://printer.local/metadata.json",
    "https://metadata.google.internal/computeMetadata",
    "https://intranet/metadata.json",
  ])("refuses the private or local host in %s", (url) => {
    expect(clientIdUrlProblem(url)).toBe(METADATA_PROBLEMS.privateHost);
  });
});

describe("clientFromMetadataDocument: the document is untrusted", () => {
  it("accepts a good document, keeping the client_id and the host that published it", () => {
    expect(clientFromMetadataDocument(DOC_URL, doc())).toEqual({
      client: {
        client_id: DOC_URL,
        client_name: "Claude",
        redirect_uris: [REDIRECT, "http://localhost/callback", "http://127.0.0.1/callback"],
        host: "client.example.com",
      },
    });
  });

  it("accepts a document without token_endpoint_auth_method, grant_types or response_types", () => {
    const minimal = { client_id: DOC_URL, client_name: "Claude", redirect_uris: [REDIRECT] };
    expect(clientFromMetadataDocument(DOC_URL, minimal)).toMatchObject({ client: { redirect_uris: [REDIRECT] } });
  });

  it.each([
    ["another URL", "https://client.example.com/oauth/other.json"],
    ["the URL with a trailing slash", `${DOC_URL}/`],
    ["the URL in another case", DOC_URL.toUpperCase()],
    ["nothing", undefined],
  ])("refuses a client_id that is %s", (_label, clientId) => {
    expect(clientFromMetadataDocument(DOC_URL, doc({ client_id: clientId }))).toEqual({
      problem: METADATA_PROBLEMS.clientIdMismatch,
    });
  });

  it.each([
    ["missing", undefined, "redirect_uris must be a list of 1 to 10 absolute URLs"],
    ["empty", [], "redirect_uris must be a list of 1 to 10 absolute URLs"],
    ["not a list", REDIRECT, "redirect_uris must be a list of 1 to 10 absolute URLs"],
    ["too many", Array.from({ length: 11 }, (_, i) => `https://client.example.com/cb${i}`), "redirect_uris must be"],
    ["http off localhost", ["http://client.example.com/cb"], "http redirect URIs are only allowed on localhost"],
    ["a script URL", ["javascript:alert(1)"], "javascript: redirect URIs aren't allowed"],
    ["with a fragment", [`${REDIRECT}#x`], "can't contain a fragment"],
  ])("refuses redirect_uris that are %s", (_label, redirectUris, wording) => {
    const result = clientFromMetadataDocument(DOC_URL, doc({ redirect_uris: redirectUris }));
    expect("problem" in result && result.problem).toMatch(/^The app's client metadata document is invalid: /);
    expect("problem" in result && result.problem).toContain(wording);
  });

  it.each(["client_secret_basic", "client_secret_post", "client_secret_jwt", "private_key_jwt", ""])(
    "refuses token_endpoint_auth_method %j: public clients only",
    (method) => {
      const result = clientFromMetadataDocument(DOC_URL, doc({ token_endpoint_auth_method: method }));
      expect("problem" in result && result.problem).toContain('token_endpoint_auth_method must be "none"');
    }
  );

  it("refuses a document carrying a client secret", () => {
    expect(clientFromMetadataDocument(DOC_URL, doc({ client_secret: "s3cret" }))).toEqual({ problem: METADATA_PROBLEMS.secret });
    expect(clientFromMetadataDocument(DOC_URL, doc({ client_secret_expires_at: 0 }))).toEqual({ problem: METADATA_PROBLEMS.secret });
  });

  it("refuses a document without a client_name, and one that isn't an object", () => {
    expect(clientFromMetadataDocument(DOC_URL, doc({ client_name: undefined }))).toEqual({ problem: METADATA_PROBLEMS.noName });
    expect(clientFromMetadataDocument(DOC_URL, doc({ client_name: 42 }))).toEqual({ problem: METADATA_PROBLEMS.noName });
    expect(clientFromMetadataDocument(DOC_URL, [doc()])).toEqual({ problem: METADATA_PROBLEMS.notJson });
    expect(clientFromMetadataDocument(DOC_URL, "Claude")).toEqual({ problem: METADATA_PROBLEMS.notJson });
    expect(clientFromMetadataDocument(DOC_URL, null)).toEqual({ problem: METADATA_PROBLEMS.notJson });
  });

  it("cleans and caps the name as registration does", () => {
    const hostile = `Claude‮\u0000${"x".repeat(300)}`;
    const result = clientFromMetadataDocument(DOC_URL, doc({ client_name: hostile }));
    const name = "client" in result ? result.client.client_name : "";
    expect(name).not.toMatch(/[‮\u0000]/);
    expect(Array.from(name).length).toBeLessThanOrEqual(100);
    expect(name.startsWith("Claude")).toBe(true);
  });

  it("drops duplicate redirect URIs", () => {
    const result = clientFromMetadataDocument(DOC_URL, doc({ redirect_uris: [REDIRECT, REDIRECT] }));
    expect("client" in result && result.client.redirect_uris).toEqual([REDIRECT]);
  });
});

describe("findClient: fetching a metadata document", () => {
  it("fetches it once with a JSON GET that follows no redirect and skips Next's cache", async () => {
    const { client, problem } = await findClient(DOC_URL);
    expect(problem).toBeNull();
    expect(client).toMatchObject({ client_id: DOC_URL, client_name: "Claude", host: "client.example.com" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe(DOC_URL);
    expect(init).toMatchObject({ redirect: "manual", cache: "no-store", headers: { Accept: "application/json" } });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.method ?? "GET").toBe("GET");
    expect(lookupMock).toHaveBeenCalledWith("client.example.com", { all: true });
  });

  it("refuses an http client_id without fetching", async () => {
    const result = await findClient("http://client.example.com/oauth/metadata.json");
    expect(result).toEqual({ client: null, problem: METADATA_PROBLEMS.url });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("refuses a private IP literal without looking anything up", async () => {
    expect(await findClient("https://192.168.1.10/metadata.json")).toEqual({ client: null, problem: METADATA_PROBLEMS.privateHost });
    expect(lookupMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a private address", [{ address: "10.0.0.5", family: 4 }]],
    ["loopback", [{ address: "127.0.0.1", family: 4 }]],
    ["the cloud metadata address", [{ address: "169.254.169.254", family: 4 }]],
    ["carrier-grade NAT space", [{ address: "100.64.0.1", family: 4 }]],
    ["IPv6 loopback", [{ address: "::1", family: 6 }]],
    ["IPv4-mapped loopback", [{ address: "::ffff:127.0.0.1", family: 6 }]],
    ["one private address among public ones", [{ address: PUBLIC_ADDRESS, family: 4 }, { address: "fd12::1", family: 6 }]],
  ])("refuses a public name that resolves to %s, without fetching", async (_label, records) => {
    lookupMock.mockResolvedValue(records);
    expect(await findClient(DOC_URL)).toEqual({ client: null, problem: METADATA_PROBLEMS.privateHost });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a host that doesn't resolve", async () => {
    lookupMock.mockRejectedValue(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }));
    expect(await findClient(DOC_URL)).toEqual({ client: null, problem: METADATA_PROBLEMS.unresolvable });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a redirect and does not follow it", async () => {
    serve(() => new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/latest/meta-data" } }));
    expect(await findClient(DOC_URL)).toEqual({ client: null, problem: METADATA_PROBLEMS.redirect });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([404, 500, 201, 204])("refuses status %i: only a 200 counts", async (status) => {
    serve(() => new Response(status === 204 ? null : JSON.stringify(doc()), { status }));
    expect(await findClient(DOC_URL)).toEqual({ client: null, problem: METADATA_PROBLEMS.status });
  });

  it("refuses a body over the cap, stopping as soon as it passes it", async () => {
    const big = JSON.stringify(doc({ client_uri: `https://client.example.com/${"a".repeat(CLIENT_METADATA_MAX_BYTES)}` }));
    let pulled = 0;
    serve(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              pulled++;
              controller.enqueue(new TextEncoder().encode(big.slice(0, 1024)));
              if (pulled > 100) controller.close();
            },
          }),
          { status: 200 }
        )
    );
    expect(await findClient(DOC_URL)).toEqual({ client: null, problem: METADATA_PROBLEMS.tooLarge });
    expect(pulled).toBeLessThan(10);
  });

  it("refuses a body whose declared length is over the cap without reading it", async () => {
    serve(() => json(doc(), { headers: { "Content-Length": String(CLIENT_METADATA_MAX_BYTES + 1) } }));
    expect(await findClient(DOC_URL)).toEqual({ client: null, problem: METADATA_PROBLEMS.tooLarge });
  });

  it("accepts a document right at the cap", async () => {
    const base = JSON.stringify(doc({ client_uri: "" }));
    const padded = doc({ client_uri: "x".repeat(CLIENT_METADATA_MAX_BYTES - base.length) });
    expect(JSON.stringify(padded).length).toBe(CLIENT_METADATA_MAX_BYTES);
    serve(() => json(padded));
    expect((await findClient(DOC_URL)).client).not.toBeNull();
  });

  it("refuses a body that isn't JSON", async () => {
    serve(() => new Response("<html>hi</html>", { status: 200, headers: { "Content-Type": "text/html" } }));
    expect(await findClient(DOC_URL)).toEqual({ client: null, problem: METADATA_PROBLEMS.notJson });
  });

  it("names a timeout, and any other network failure", async () => {
    fetchMock.mockRejectedValueOnce(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    expect(await findClient(DOC_URL)).toEqual({ client: null, problem: METADATA_PROBLEMS.timeout });
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await findClient(DOC_URL)).toEqual({ client: null, problem: METADATA_PROBLEMS.unreachable });
  });

  it("refuses a document that fails validation", async () => {
    serve(() => json(doc({ client_id: "https://someone-else.example/metadata.json" })));
    expect(await findClient(DOC_URL)).toEqual({ client: null, problem: METADATA_PROBLEMS.clientIdMismatch });
  });
});

describe("the metadata cache", () => {
  it("serves a validated document for five minutes, then fetches it again", async () => {
    await findClient(DOC_URL);
    vi.setSystemTime(T0.getTime() + 5 * MINUTE - 1);
    await findClient(DOC_URL);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    serve(() => json(doc({ client_name: "Claude, renamed" })));
    vi.setSystemTime(T0.getTime() + 5 * MINUTE);
    expect((await findClient(DOC_URL)).client?.client_name).toBe("Claude, renamed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never caches a failure or an invalid document", async () => {
    serve(() => new Response("nope", { status: 503 }));
    expect((await findClient(DOC_URL)).client).toBeNull();
    serve(() => json(doc({ redirect_uris: [] })));
    expect((await findClient(DOC_URL)).client).toBeNull();
    serve(() => json(doc()));
    expect((await findClient(DOC_URL)).client).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("drops an expired document when the refetch fails", async () => {
    await findClient(DOC_URL);
    vi.setSystemTime(T0.getTime() + 6 * MINUTE);
    serve(() => new Response("gone", { status: 404 }));
    expect((await findClient(DOC_URL)).problem).toBe(METADATA_PROBLEMS.status);
    vi.setSystemTime(T0.getTime() + 6 * MINUTE + 1);
    expect((await findClient(DOC_URL)).problem).toBe(METADATA_PROBLEMS.status);
  });

  it("keeps each URL separately", async () => {
    const other = "https://client.example.com/oauth/other.json";
    serve(() => json(doc()));
    await findClient(DOC_URL);
    serve(() => json(doc({ client_id: other, client_name: "Other" })));
    expect((await findClient(other)).client?.client_name).toBe("Other");
    expect((await findClient(DOC_URL)).client?.client_name).toBe("Claude");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("GET /oauth/authorize and the consent page with a URL client_id", () => {
  it("accepts the client without any registration, and the consent page reuses the fetched document", async () => {
    const query = authorizeQuery({ client_id: DOC_URL });
    const res = await authorize(query);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${APP}/oauth/authorize/consent?${query}`);

    const html = decodeHtml(await renderConsent(query));
    expect(html).toContain("Connect Claude (client.example.com)?");
    expect(html).toContain("Claude (client.example.com) wants to:");
    expect(html).toContain("published at client.example.com, and anyone can publish one under any name");
    expect(html).toContain("claude.ai"); // where the browser goes next
    expect(html).not.toContain("program on this computer");
    expect(consentField(html)).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fake.tables.oauth_clients).toHaveLength(2); // nothing stored before approval
  });

  it("warns when the client returns to a program on this computer", async () => {
    const html = decodeHtml(await renderConsent(authorizeQuery({ client_id: DOC_URL, redirect_uri: "http://localhost:51234/callback" })));
    expect(html).toContain("Connect Claude (client.example.com)?");
    expect(html).toContain("localhost:51234");
    expect(html).toContain("That is a program on this computer, and any program can say it is Claude.");
  });

  it("refuses a redirect_uri the document doesn't list, with no link back", async () => {
    const res = await authorize(authorizeQuery({ client_id: DOC_URL, redirect_uri: "https://evil.example/callback" }));
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    const html = decodeHtml(await res.text());
    expect(html).toContain("The app asked to return to an address it didn't register.");
    expect(html).not.toContain("Return to");
    expect(html).not.toContain("evil.example");
  });

  it("names a fetch failure on the error page, never redirecting and never echoing the address", async () => {
    serve(() => new Response(null, { status: 301, headers: { Location: "https://elsewhere.example/doc.json" } }));
    const res = await authorize(authorizeQuery({ client_id: DOC_URL }));
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    const html = decodeHtml(await res.text());
    expect(html).toContain(METADATA_PROBLEMS.redirect);
    expect(html).not.toContain("elsewhere.example");
    expect(html).not.toContain("Return to");
  });

  it("refuses a private client_id before fetching anything", async () => {
    const res = await authorize(authorizeQuery({ client_id: "https://169.254.169.254/latest/meta-data" }));
    expect(res.status).toBe(400);
    expect(decodeHtml(await res.text())).toContain(METADATA_PROBLEMS.privateHost);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checks the document's redirect URIs, not the row an earlier approval left", async () => {
    await approve();
    expect(fake.tables.oauth_clients.find((c) => c.client_id === DOC_URL)).toBeDefined();
    // The client drops claude.ai from its document; after the cache expires that counts at once.
    vi.setSystemTime(T0.getTime() + 6 * MINUTE);
    serve(() => json(doc({ redirect_uris: ["http://localhost/callback"] })));
    expect((await authorize(authorizeQuery({ client_id: DOC_URL }))).status).toBe(400);
  });
});

describe("POST /api/oauth/decision with a URL client_id", () => {
  it("on approve, records the client under its URL and stores a code for it", async () => {
    const { code } = await approve();
    expect(fake.tables.oauth_clients.filter((c) => c.client_id === DOC_URL)).toEqual([
      expect.objectContaining({
        client_id: DOC_URL,
        client_name: "Claude",
        redirect_uris: [REDIRECT, "http://localhost/callback", "http://127.0.0.1/callback"],
        token_endpoint_auth_method: "none",
      }),
    ]);
    expect(fake.tables.oauth_codes).toEqual([
      expect.objectContaining({ code_hash: sha256Hex(code), client_id: DOC_URL, redirect_uri: REDIRECT, user_id: USER_ID }),
    ]);
  });

  it("refreshes the same row on a later approval rather than adding one", async () => {
    await approve();
    vi.setSystemTime(T0.getTime() + 6 * MINUTE);
    serve(() => json(doc({ client_name: "Claude (new)" })));
    await approve();
    const rows = fake.tables.oauth_clients.filter((c) => c.client_id === DOC_URL);
    expect(rows).toHaveLength(1);
    expect(rows[0].client_name).toBe("Claude (new)");
  });

  it("on deny, stores nothing", async () => {
    const query = authorizeQuery({ client_id: DOC_URL });
    const res = await decide(consentField(await renderConsent(query))!, "deny");
    expect(res.status).toBe(303);
    expect(locationOf(res).searchParams.get("error")).toBe("access_denied");
    expect(fake.tables.oauth_clients.some((c) => c.client_id === DOC_URL)).toBe(false);
    expect(fake.tables.oauth_codes).toEqual([]);
  });

  it("re-checks the document: a failed fetch after the cache expired gets the error page", async () => {
    const blob = consentField(await renderConsent(authorizeQuery({ client_id: DOC_URL })))!;
    vi.setSystemTime(T0.getTime() + 5 * MINUTE);
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    const res = await decide(blob, "approve");
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(decodeHtml(await res.text())).toContain(METADATA_PROBLEMS.unreachable);
    expect(fake.tables.oauth_codes).toEqual([]);
  });
});

describe("POST /oauth/token with a URL client_id", () => {
  it("exchanges the code for a token tagged with the URL, with one fetch for the whole sign-in", async () => {
    const { code, verifier } = await approve();
    const res = await exchange(code, verifier);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ token_type: "Bearer", scope: "read" });
    expect(fake.tables.api_tokens).toEqual([
      expect.objectContaining({
        client_id: DOC_URL,
        name: "Claude (client.example.com)",
        token_hash: sha256Hex(body.access_token),
        refresh_token_hash: sha256Hex(body.refresh_token),
      }),
    ]);
    expect(fake.tables.oauth_clients.find((c) => c.client_id === DOC_URL)?.last_used_at).toBe(T0.toISOString());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes without fetching anything", async () => {
    const { code, verifier } = await approve();
    const { refresh_token: refreshToken } = await (await exchange(code, verifier)).json();
    forgetClientMetadata();
    fetchMock.mockClear();
    const res = await token({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: DOC_URL });
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("replaces the client's earlier connection when it connects again", async () => {
    const first = await approve();
    expect((await exchange(first.code, first.verifier)).status).toBe(200);
    const second = await approve();
    expect((await exchange(second.code, second.verifier)).status).toBe(200);
    const tokens = fake.tables.api_tokens.filter((t) => t.client_id === DOC_URL);
    expect(tokens).toHaveLength(2);
    expect(tokens[0].revoked_at).toBeTruthy();
    expect(tokens[1].revoked_at ?? null).toBeNull();
  });

  it("answers invalid_client for a URL nobody approved, and doesn't fetch it", async () => {
    const res = await exchange("x".repeat(43), pkcePair().verifier);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("invalid_client");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await getClient(DOC_URL)).toBeNull();
  });
});
