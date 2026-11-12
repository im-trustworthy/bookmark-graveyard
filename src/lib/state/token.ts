// The lifecycle of an api_tokens row, in one place. A row has no status
// column: its state follows from two nullable timestamps, revoked_at and
// expires_at, so every reader asks tokenStatus instead of reading them itself.
// Whether the owner is still allowed is a separate question (src/lib/allowlist.ts):
// it can change back, while a revocation never does.
//
// Pure on purpose: no I/O and no server imports, so server code, client
// components and tests can all use it.

export const TOKEN_STATUSES = ["active", "expired", "revoked"] as const;
export type TokenStatus = (typeof TOKEN_STATUSES)[number];

/**
 * Legal moves. Expiry passes on its own; an OAuth refresh rotates the row in
 * place with a fresh expiry, which is how an expired row becomes active again.
 * Revocation is terminal: every revoke write is conditional on revoked_at
 * still being null, so nothing moves a row out of it.
 */
export const TOKEN_TRANSITIONS: Readonly<Record<TokenStatus, readonly TokenStatus[]>> = {
  active: ["expired", "revoked"],
  expired: ["active", "revoked"],
  revoked: [],
};

export function canMoveToken(from: TokenStatus, to: TokenStatus): boolean {
  return TOKEN_TRANSITIONS[from].includes(to);
}

/**
 * Whether a row is past its expiry at `now` (no expiry: never). An expiry that
 * doesn't parse counts as not expired, as it always has; the column is a
 * timestamptz, so the database never hands back one.
 */
export function isExpired(expiresAt: string | null | undefined, now = Date.now()): boolean {
  return !!expiresAt && Date.parse(expiresAt) <= now;
}

/** The row's state at `now`. A revoked row stays revoked whatever its expiry says. */
export function tokenStatus(
  row: { revoked_at: string | null; expires_at: string | null },
  now = Date.now()
): TokenStatus {
  if (row.revoked_at) return "revoked";
  if (isExpired(row.expires_at, now)) return "expired";
  return "active";
}

/** Which states a bearer token is accepted in: an API call, or a slot under the per-user ceiling. */
export const BEARER_USABLE_STATUSES: readonly TokenStatus[] = ["active"];
/**
 * Which states a refresh token is accepted in. Expired is in on purpose:
 * refreshing an expired access token is what refreshing is for.
 */
export const REFRESHABLE_STATUSES: readonly TokenStatus[] = ["active", "expired"];

/** Whether the row's state at `now` is one of `accepted`. */
export function tokenStatusIn(
  accepted: readonly TokenStatus[],
  row: { revoked_at: string | null; expires_at: string | null },
  now = Date.now()
): boolean {
  return accepted.includes(tokenStatus(row, now));
}
