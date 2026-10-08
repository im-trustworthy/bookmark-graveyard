import { NextResponse } from "next/server";
import { getCapacity } from "@/lib/capacity";
import { apiError } from "@/lib/errors";
import { getSessionUserId } from "@/lib/session";

export const maxDuration = 60;

// How full this instance's Supabase project is (file storage and database),
// with what to do about it, for the dashboard's capacity panel.
export async function GET() {
  const context = "GET /api/capacity";
  const userId = await getSessionUserId();
  if (!userId) return apiError(context, "no session", "Not logged in", 401);
  try {
    return NextResponse.json(await getCapacity());
  } catch (err) {
    return apiError(context, err, "Couldn't check storage capacity");
  }
}
