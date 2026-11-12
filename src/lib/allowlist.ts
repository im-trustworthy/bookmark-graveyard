import "server-only";
import { db } from "./supabase";

// Whether a user may still use the app at all: users.is_allowed, read fresh
// every time, so taking someone off the allowlist cuts off their tokens,
// connections and consent screens at once. Imports only the database client,
// so api-tokens.ts and oauth.ts (which imports api-tokens.ts) can both use it.

/**
 * Whether the user still exists and is still on the allowlist. Throws only
 * when the database can't be asked, with `errorPrefix` (default "User lookup
 * failed") in front of the database's message, so each caller keeps its own.
 */
export async function isUserAllowed(
  userId: string,
  opts: { errorPrefix?: string } = {}
): Promise<boolean> {
  const { data, error } = await db().from("users").select("is_allowed").eq("id", userId).maybeSingle();
  if (error) throw new Error(`${opts.errorPrefix ?? "User lookup failed"}: ${error.message}`);
  return !!data?.is_allowed;
}
