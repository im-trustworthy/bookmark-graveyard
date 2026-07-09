import { NextResponse } from "next/server";
import { appUrl } from "@/lib/env";
import { clearSession } from "@/lib/session";

export async function POST() {
  await clearSession();
  return NextResponse.redirect(appUrl(), { status: 303 });
}
