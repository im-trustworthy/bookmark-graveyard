import type { NextRequest } from "next/server";
import { redirectToEpisodeFile } from "../shared";

// A stable link to a finished brief's markdown: 302 to a fresh signed URL (see ../shared.ts).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return redirectToEpisodeFile(req, params, "markdown");
}
