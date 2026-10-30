import { NextResponse } from "next/server";
import type { DigestStageError } from "@/lib/digest";
import { apiError } from "@/lib/errors";

/**
 * The response for a DigestStageError thrown by a stage in src/lib/digest.ts, shared by the four stage
 * routes. It keeps each answer as the routes gave it before the stages moved into the library: with a
 * logDetail the refusal goes through apiError (logged, and outside production the detail is appended to
 * the message); without one it is a bare JSON error that is not logged.
 */
export function stageErrorResponse(context: string, err: DigestStageError): NextResponse {
  if (err.logDetail === undefined) {
    return NextResponse.json({ error: err.publicMessage }, { status: err.status });
  }
  return apiError(context, err.logDetail, err.publicMessage, err.status);
}
