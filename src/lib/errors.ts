import "server-only";
import { NextResponse } from "next/server";
import { UsageLimitError } from "./limits";

/**
 * Uniform route error response. Full detail always goes to the server log;
 * the client gets the generic message in production and the underlying
 * detail appended in development.
 */
export function apiError(
  context: string,
  err: unknown,
  publicMessage: string,
  status = 500
): NextResponse {
  console.error(`${context}:`, err);
  if (err instanceof UsageLimitError) {
    return NextResponse.json({ error: err.message }, { status: 429 });
  }
  const detail =
    process.env.NODE_ENV !== "production"
      ? ` — ${err instanceof Error ? err.message : String(err)}`
      : "";
  return NextResponse.json({ error: `${publicMessage}${detail}` }, { status });
}
