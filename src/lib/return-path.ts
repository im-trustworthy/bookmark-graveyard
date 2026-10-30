// Where to send someone after X sign-in, when they started somewhere other than
// the dashboard (the OAuth consent step, so far). /api/auth/login?next=… keeps
// it in the bb_next cookie and the X callback goes there afterwards. Only a
// path on this app is ever accepted, so it can't become an open redirect.

export const RETURN_PATH_COOKIE = "bb_next";
const MAX_LENGTH = 2048;
const BASE = "http://return-path.invalid";

/**
 * `raw` when it is a same-origin relative path: starts with "/" but not "//",
 * has no backslash or control character, and resolves to the same origin.
 * Null for anything else.
 */
export function safeReturnPath(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw || raw.length > MAX_LENGTH) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return null;
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  try {
    return new URL(raw, BASE).origin === BASE ? raw : null;
  } catch {
    return null;
  }
}
