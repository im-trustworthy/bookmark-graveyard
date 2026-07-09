import { createHash } from "crypto";
import { describe, expect, it } from "vitest";
import { authorizeUrl, callbackUrl, generatePkce, SCOPES } from "../x";

const BASE64URL = /^[A-Za-z0-9_-]+$/;

describe("generatePkce", () => {
  it("returns a verifier, challenge, and state made of base64url characters only", () => {
    const { verifier, challenge, state } = generatePkce();
    expect(verifier).toMatch(BASE64URL);
    expect(challenge).toMatch(BASE64URL);
    expect(state).toMatch(BASE64URL);
    for (const value of [verifier, challenge, state]) {
      expect(value).not.toMatch(/[+/=]/); // standard-base64-only chars / padding must be absent
    }
  });

  it("derives verifier from 32 random bytes and state from 16 random bytes", () => {
    const { verifier, state } = generatePkce();
    expect(Buffer.from(verifier, "base64url")).toHaveLength(32);
    expect(Buffer.from(state, "base64url")).toHaveLength(16);
  });

  it("computes challenge as base64url(sha256(verifier)) — the S256 method", () => {
    const { verifier, challenge } = generatePkce();
    const expected = createHash("sha256").update(verifier).digest("base64url");
    expect(challenge).toBe(expected);
    expect(Buffer.from(challenge, "base64url")).toHaveLength(32); // sha256 digest size
  });

  it("generates fresh randomness on every call", () => {
    const a = generatePkce();
    const b = generatePkce();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.state).not.toBe(b.state);
    expect(a.challenge).not.toBe(b.challenge);
  });
});

describe("authorizeUrl", () => {
  it("builds a URL against X's authorize endpoint with all required params", () => {
    const { challenge, state } = generatePkce();
    const url = new URL(authorizeUrl(challenge, state));

    expect(url.origin + url.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(process.env.X_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(callbackUrl());
    expect(url.searchParams.get("scope")).toBe(SCOPES.join(" "));
    expect(url.searchParams.get("state")).toBe(state);
    expect(url.searchParams.get("code_challenge")).toBe(challenge);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("includes offline.access in scope so refresh tokens are issued", () => {
    const url = new URL(authorizeUrl("c", "s"));
    expect(url.searchParams.get("scope")?.split(" ")).toContain("offline.access");
  });

  it("round-trips state/challenge values containing reserved URL characters", () => {
    const weirdState = "state with spaces/&special?chars";
    const weirdChallenge = "challenge+with/special=chars";
    const url = new URL(authorizeUrl(weirdChallenge, weirdState));
    expect(url.searchParams.get("state")).toBe(weirdState);
    expect(url.searchParams.get("code_challenge")).toBe(weirdChallenge);
  });
});
