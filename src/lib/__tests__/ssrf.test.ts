// Regression coverage for the SSRF hardening of isPrivateHost (see ingest.ts).
// A senior review found three bypasses of the pre-fix isPrivateHost, which
// only string-matched the *original* URL's hostname:
//   1. Redirect bypass — a public URL 302s to a private address. (Closed in
//      fetchArticle via manual redirect-following + per-hop revalidation;
//      not exercisable as a pure function and so not covered here.)
//   2. DNS bypass — a public hostname resolves to a private A/AAAA record.
//      (Also closed in fetchArticle, via dns.lookup + isPrivateHost on the
//      resolved addresses; not a pure-function concern either.)
//   3. IPv6 literal bypass — verified: `new URL("http://[::1]/").hostname`
//      is "[::1]" (brackets included), so the old `h === "::1"` check never
//      fired. This file covers that case, plus the other IPv6 forms the fix
//      added (ULA, link-local, IPv4-mapped), and confirms the pre-existing
//      IPv4/hostname rules are untouched.
//
// isPrivateHost is a pure, synchronous function — no DNS or network calls
// happen here.

import { describe, expect, it } from "vitest";
import { isPrivateHost } from "../ingest";

describe("isPrivateHost — IPv6 literals", () => {
  it.each([
    ["[::1]", "loopback, bracketed (as URL.hostname produces it)"],
    ["::1", "loopback, bare"],
    ["[::]", "unspecified address, bracketed"],
    ["::", "unspecified address, bare"],
    ["0:0:0:0:0:0:0:1", "loopback, fully expanded (no :: shorthand)"],
    ["[fd00::1]", "ULA fc00::/7 — the exact bypass example from the review"],
    ["fd00::1", "ULA fc00::/7, bare"],
    ["fc00::1", "ULA fc00::/7 lower boundary"],
    ["fdff::1", "ULA fc00::/7 upper boundary"],
    ["FD00::1", "ULA fc00::/7, uppercase"],
    ["[fe80::1]", "link-local fe80::/10 — the exact bypass example from the review"],
    ["fe80::1", "link-local fe80::/10, bare"],
    ["febf::1", "link-local fe80::/10 upper boundary"],
    ["[::ffff:127.0.0.1]", "IPv4-mapped loopback — the exact bypass example from the review"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback, bare"],
    ["::ffff:7f00:1", "IPv4-mapped loopback, hex form (what URL normalizes the dotted form to)"],
    ["::ffff:10.0.0.1", "IPv4-mapped 10/8"],
    ["::ffff:a00:1", "IPv4-mapped 10/8, hex form"],
    ["::ffff:169.254.1.1", "IPv4-mapped link-local v4"],
  ])("treats %s (%s) as private", (host) => {
    expect(isPrivateHost(host)).toBe(true);
  });

  it.each([
    ["[2606:4700::1]", "Cloudflare, bracketed"],
    ["2606:4700::1", "Cloudflare, bare"],
    ["2001:4860:4860::8888", "Google public DNS"],
    ["::ffff:8.8.8.8", "IPv4-mapped public address"],
    ["::ffff:808:808", "IPv4-mapped public address, hex form"],
    ["fbff::1", "just below the fc00::/7 lower boundary"],
    ["fe00::1", "between fc00::/7 and fe80::/10 (neither range)"],
    ["fe7f::1", "just below the fe80::/10 lower boundary"],
    ["fec0::1", "just above the fe80::/10 upper boundary"],
  ])("treats %s (%s) as public", (host) => {
    expect(isPrivateHost(host)).toBe(false);
  });

  it("does not throw on malformed IPv6-ish strings, and treats them as public", () => {
    expect(() => isPrivateHost(":::1")).not.toThrow();
    expect(isPrivateHost(":::1")).toBe(false);
    expect(() => isPrivateHost("not:a:valid:address:with:too:many:groups:here")).not.toThrow();
    expect(isPrivateHost("not:a:valid:address:with:too:many:groups:here")).toBe(false);
  });

  it("reproduces the verified bypass report exactly: URL.hostname keeps IPv6 brackets", () => {
    expect(new URL("http://[::1]/").hostname).toBe("[::1]");
    expect(isPrivateHost(new URL("http://[::1]/").hostname)).toBe(true);
    expect(isPrivateHost(new URL("http://[fd00::1]/").hostname)).toBe(true);
    expect(isPrivateHost(new URL("http://[fe80::1]/").hostname)).toBe(true);
    expect(isPrivateHost(new URL("http://[::ffff:127.0.0.1]/").hostname)).toBe(true);
    // and a real public IPv6 host must NOT be caught by the same logic
    expect(isPrivateHost(new URL("http://[2606:4700::1]/").hostname)).toBe(false);
  });
});

describe("isPrivateHost — pre-existing IPv4 + hostname rules (must stay intact)", () => {
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
