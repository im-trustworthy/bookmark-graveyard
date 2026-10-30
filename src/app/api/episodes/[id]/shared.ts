import "server-only";
import { NextResponse } from "next/server";
import { getUserIdFromRequest } from "@/lib/auth";
import { apiError } from "@/lib/errors";
import { db } from "@/lib/supabase";

// Stable links to a finished brief's files, for links that leave the app: an assistant pastes them into a
// chat, which outlives any signed URL. Each visit checks the caller (the session cookie, or a bearer token
// with the read scope), then answers 302 to a fresh one-hour signed URL. A browser that isn't signed in is
// sent to the sign-in page instead of a JSON 401. The dashboard keeps using signed URLs directly.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIGNED_URL_SECONDS = 60 * 60;

export type EpisodeFile = "audio" | "markdown";

interface EpisodeFiles {
  status: string;
  markdown_path: string | null;
  audio_path: string | null;
  audio_pruned_at: string | null;
}

/** A navigation from a browser tab rather than a call from code. */
function isBrowserNavigation(req: Request): boolean {
  return (req.headers.get("accept") ?? "").includes("text/html");
}

/** GET /api/episodes/[id]/audio and /markdown: a 302 to a fresh signed URL for the caller's own ready brief. */
export async function redirectToEpisodeFile(
  req: Request,
  params: Promise<{ id: string }>,
  file: EpisodeFile
): Promise<NextResponse> {
  const context = `GET /api/episodes/[id]/${file}`;
  const { id } = await params;
  // Not a uuid can't be an episode; answering here also keeps a malformed id away from Postgres.
  if (!UUID_RE.test(id)) return apiError(context, "malformed episode id", "Episode not found", 404);

  let userId: string;
  try {
    const auth = await getUserIdFromRequest(req, { scope: "read" });
    if (!auth) {
      if (isBrowserNavigation(req)) return NextResponse.redirect(new URL("/", req.url), 302);
      return apiError(context, "no session or token", "Not logged in", 401);
    }
    userId = auth.userId;
  } catch (err) {
    return apiError(context, err, "Couldn't check who is asking");
  }

  const { data, error } = await db()
    .from("episodes")
    .select("status, markdown_path, audio_path, audio_pruned_at")
    .eq("user_id", userId)
    .eq("id", id)
    .maybeSingle();
  if (error) return apiError(context, new Error(error.message), "Couldn't load the episode");
  const episode = data as EpisodeFiles | null;
  // Someone else's brief, a draft and a made-up id all look the same.
  if (!episode || episode.status !== "ready") return apiError(context, "no ready episode", "Episode not found", 404);

  let path: string | null;
  if (file === "audio") {
    if (episode.audio_pruned_at) {
      return apiError(context, "audio pruned", "This episode's audio was pruned to free space", 404);
    }
    if (!episode.audio_path) return apiError(context, "no audio", "This episode has no audio", 404);
    path = episode.audio_path;
  } else {
    path = episode.markdown_path;
    if (!path) return apiError(context, "no markdown", "Episode not found", 404);
  }

  const { data: signed, error: signError } = await db()
    .storage.from("episodes")
    .createSignedUrl(path, SIGNED_URL_SECONDS);
  if (signError || !signed?.signedUrl) {
    return apiError(context, new Error(signError?.message ?? "no signed URL"), "Couldn't create a download link");
  }
  const res = NextResponse.redirect(signed.signedUrl, 302);
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}
