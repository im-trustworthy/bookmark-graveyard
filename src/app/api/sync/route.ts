import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";
import { syncUser } from "@/lib/sync";

export const maxDuration = 300;

export async function POST() {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not logged in" }, { status: 401 });

  try {
    return NextResponse.json(await syncUser(userId));
  } catch (err) {
    console.error("Sync error:", err);
    const message = err instanceof Error ? err.message : "Sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
