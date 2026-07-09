import { describe, expect, it } from "vitest";
import { extractArticleUrls, isPrivateHost } from "../ingest";
import type { ReferencedTweet } from "../x";

function ref(text: string | null): ReferencedTweet {
  return { type: "quoted", id: "1", text, author_handle: "someone" };
}

describe("extractArticleUrls", () => {
  it("returns [] when there are no urls anywhere", () => {
    expect(extractArticleUrls(undefined, [])).toEqual([]);
    expect(extractArticleUrls({}, [])).toEqual([]);
    expect(extractArticleUrls({ urls: [] }, [])).toEqual([]);
  });

  it("extracts expanded_url from entities.urls", () => {
    const entities = { urls: [{ expanded_url: "https://example.com/article" }] };
    expect(extractArticleUrls(entities, [])).toEqual(["https://example.com/article"]);
  });

  it("prefers unwound_url, then expanded_url, then bare url", () => {
    const entities = {
      urls: [
        {
          url: "https://t.co/abc",
          expanded_url: "https://bit.ly/xyz",
          unwound_url: "https://example.com/real-article",
        },
      ],
    };
    expect(extractArticleUrls(entities, [])).toEqual(["https://example.com/real-article"]);
  });

  it("falls back to the bare url field when expanded/unwound are absent", () => {
    const entities = { urls: [{ url: "https://example.com/fallback" }] };
    expect(extractArticleUrls(entities, [])).toEqual(["https://example.com/fallback"]);
  });

  it("skips url entries with no usable url field", () => {
    expect(extractArticleUrls({ urls: [{}] }, [])).toEqual([]);
  });

  it("extracts urls embedded in referenced-tweet text", () => {
    const referenced = [ref("check this out https://example.com/quoted-link")];
    expect(extractArticleUrls(undefined, referenced)).toEqual(["https://example.com/quoted-link"]);
  });

  it("extracts multiple urls from a single referenced tweet's text", () => {
    const referenced = [ref("see https://example.com/one and https://example.org/two")];
    expect(extractArticleUrls(undefined, referenced)).toEqual([
      "https://example.com/one",
      "https://example.org/two",
    ]);
  });

  it("handles referenced tweets with null text", () => {
    expect(extractArticleUrls(undefined, [ref(null)])).toEqual([]);
  });

  it("combines entities urls and referenced-tweet urls, entities first", () => {
    const entities = { urls: [{ expanded_url: "https://example.com/from-entities" }] };
    const referenced = [ref("https://example.com/from-reference")];
    expect(extractArticleUrls(entities, referenced)).toEqual([
      "https://example.com/from-entities",
      "https://example.com/from-reference",
    ]);
  });

  it("dedupes identical urls appearing in both entities and referenced text", () => {
    const entities = { urls: [{ expanded_url: "https://example.com/dup" }] };
    const referenced = [ref("https://example.com/dup")];
    expect(extractArticleUrls(entities, referenced)).toEqual(["https://example.com/dup"]);
  });

  it.each([
    "https://x.com/someone/status/123",
    "https://twitter.com/someone/status/123",
    "https://t.co/abc123",
    "https://pic.twitter.com/abc123",
    "https://TWITTER.com/someone",
  ])("filters out X-internal host: %s", (url) => {
    expect(extractArticleUrls({ urls: [{ expanded_url: url }] }, [])).toEqual([]);
  });

  it("does not filter hosts that merely contain x.com/twitter.com as a substring", () => {
    // "notx.com" and "faketwitter.com" are unrelated domains, not subdomains
    // of x.com / twitter.com — the source regex requires a "." or start-of-
    // string boundary immediately before the matched domain.
    const entities = {
      urls: [{ expanded_url: "https://notx.com/article" }, { expanded_url: "https://faketwitter.com/article" }],
    };
    expect(extractArticleUrls(entities, [])).toEqual([
      "https://notx.com/article",
      "https://faketwitter.com/article",
    ]);
  });

  it.each([
    "http://localhost/secret",
    "http://127.0.0.1/secret",
    "http://10.0.0.5/secret",
    "http://172.16.0.1/secret",
    "http://172.31.255.255/secret",
    "http://192.168.1.1/secret",
    "http://169.254.1.1/secret",
    "http://internal-tool.local/secret",
    "http://box.internal/secret",
  ])("filters out private/internal host: %s", (url) => {
    expect(extractArticleUrls({ urls: [{ expanded_url: url }] }, [])).toEqual([]);
  });

  it("filters out non-http(s) protocols", () => {
    const entities = {
      urls: [{ expanded_url: "ftp://example.com/file" }, { expanded_url: "javascript:alert(1)" }],
    };
    expect(extractArticleUrls(entities, [])).toEqual([]);
  });

  it("filters out unparseable urls without throwing", () => {
    const entities = { urls: [{ expanded_url: "not a url" }] };
    expect(() => extractArticleUrls(entities, [])).not.toThrow();
    expect(extractArticleUrls(entities, [])).toEqual([]);
  });

  it("caps results at 3 urls, preserving order", () => {
    const entities = {
      urls: [1, 2, 3, 4, 5].map((n) => ({ expanded_url: `https://example.com/${n}` })),
    };
    expect(extractArticleUrls(entities, [])).toEqual([
      "https://example.com/1",
      "https://example.com/2",
      "https://example.com/3",
    ]);
  });

  it("caps at 3 after filtering, so filtered-out urls don't count against the cap", () => {
    const entities = {
      urls: [
        { expanded_url: "https://x.com/status/1" }, // filtered
        { expanded_url: "https://example.com/1" },
        { expanded_url: "http://localhost/secret" }, // filtered
        { expanded_url: "https://example.com/2" },
        { expanded_url: "https://example.com/3" },
        { expanded_url: "https://example.com/4" },
      ],
    };
    expect(extractArticleUrls(entities, [])).toEqual([
      "https://example.com/1",
      "https://example.com/2",
      "https://example.com/3",
    ]);
  });
});

describe("isPrivateHost", () => {
  it.each([
    "localhost",
    "LOCALHOST",
    "foo.local",
    "foo.internal",
    "127.0.0.1",
    "127.255.255.255",
    "10.0.0.1",
    "10.255.255.255",
    "192.168.0.1",
    "192.168.255.255",
    "169.254.1.1",
    "0.0.0.0",
    "172.16.0.0",
    "172.31.255.255",
    "172.20.5.5",
    "::1",
  ])("treats %s as private", (host) => {
    expect(isPrivateHost(host)).toBe(true);
  });

  it.each([
    "example.com",
    "sub.example.com",
    "8.8.8.8",
    "172.15.255.255", // just below the private 172.16-31 range
    "172.32.0.0", // just above the private 172.16-31 range
    "1172.16.0.1", // must be anchored, not a substring match
    "notlocalhost", // must be an exact/suffix match, not a substring
  ])("treats %s as public", (host) => {
    expect(isPrivateHost(host)).toBe(false);
  });
});
