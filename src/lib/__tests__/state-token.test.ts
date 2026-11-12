import { describe, expect, it } from "vitest";
import {
  BEARER_USABLE_STATUSES,
  canMoveToken,
  isExpired,
  REFRESHABLE_STATUSES,
  TOKEN_STATUSES,
  TOKEN_TRANSITIONS,
  tokenStatus,
  tokenStatusIn,
} from "@/lib/state/token";
import type { TokenStatus } from "@/lib/state/token";

// The api_tokens lifecycle: the transition table, how a row's two timestamps
// map to a state, and that each reader's accepted set is what it was when the
// readers spelled out the timestamps themselves.

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const PAST = "2026-10-31T12:00:00.000Z";
const FUTURE = "2026-11-02T12:00:00.000Z";

describe("TOKEN_TRANSITIONS / canMoveToken", () => {
  const legal: Record<TokenStatus, TokenStatus[]> = {
    active: ["expired", "revoked"],
    expired: ["active", "revoked"],
    revoked: [],
  };

  for (const from of TOKEN_STATUSES) {
    for (const to of TOKEN_STATUSES) {
      const allowed = legal[from].includes(to);
      it(`${from} -> ${to}: ${allowed ? "allowed" : "refused"}`, () => {
        expect(canMoveToken(from, to)).toBe(allowed);
      });
    }
  }

  it("has an entry for every state and nothing else", () => {
    expect(Object.keys(TOKEN_TRANSITIONS).sort()).toEqual([...TOKEN_STATUSES].sort());
  });
});

describe("tokenStatus", () => {
  it("revoked wins over expired", () => {
    expect(tokenStatus({ revoked_at: PAST, expires_at: PAST }, NOW)).toBe("revoked");
  });
  it("revoked only", () => {
    expect(tokenStatus({ revoked_at: PAST, expires_at: FUTURE }, NOW)).toBe("revoked");
    expect(tokenStatus({ revoked_at: PAST, expires_at: null }, NOW)).toBe("revoked");
  });
  it("expired only", () => {
    expect(tokenStatus({ revoked_at: null, expires_at: PAST }, NOW)).toBe("expired");
    // The boundary counts as expired.
    expect(tokenStatus({ revoked_at: null, expires_at: new Date(NOW).toISOString() }, NOW)).toBe("expired");
  });
  it("never expiring", () => {
    expect(tokenStatus({ revoked_at: null, expires_at: null }, NOW)).toBe("active");
  });
  it("an unparseable expiry reads as active, as isExpired always had it", () => {
    expect(tokenStatus({ revoked_at: null, expires_at: "not a date" }, NOW)).toBe("active");
  });
  it("defaults now to the current time", () => {
    expect(tokenStatus({ revoked_at: null, expires_at: "2000-01-01T00:00:00.000Z" })).toBe("expired");
    expect(tokenStatus({ revoked_at: null, expires_at: "2999-01-01T00:00:00.000Z" })).toBe("active");
  });
});

// Every expiry and revocation value the readers can meet, including the odd ones.
const EXPIRIES: (string | null | undefined)[] = [null, undefined, "", "not a date", PAST, FUTURE, new Date(NOW).toISOString()];
const REVOCATIONS: (string | null | undefined)[] = [null, undefined, "", PAST];

describe("isExpired parity with the implementation it replaced", () => {
  const before = (expiresAt: string | null | undefined, now: number) => !!expiresAt && Date.parse(expiresAt) <= now;
  for (const expiresAt of EXPIRIES) {
    it(`${JSON.stringify(expiresAt)}`, () => {
      expect(isExpired(expiresAt, NOW)).toBe(before(expiresAt, NOW));
    });
  }
});

describe("accepted sets match each reader's old check", () => {
  type Row = { revoked_at: string | null; expires_at: string | null };
  const cases = REVOCATIONS.flatMap((revoked_at) =>
    EXPIRIES.map((expires_at) => ({ revoked_at, expires_at }) as Row)
  );

  it("verifyApiToken and countActiveApiTokens: not revoked and not expired", () => {
    for (const row of cases) {
      const before = !row.revoked_at && !isExpired(row.expires_at, NOW);
      expect(tokenStatusIn(BEARER_USABLE_STATUSES, row, NOW), JSON.stringify(row)).toBe(before);
    }
  });

  it("findRefreshGrant: not revoked, whatever the expiry", () => {
    for (const row of cases) {
      expect(tokenStatusIn(REFRESHABLE_STATUSES, row, NOW), JSON.stringify(row)).toBe(!row.revoked_at);
    }
  });

  it("names the sets the readers rely on", () => {
    expect(BEARER_USABLE_STATUSES).toEqual(["active"]);
    expect([...REFRESHABLE_STATUSES].sort()).toEqual(["active", "expired"]);
  });
});
