import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { getSessionUserId } from "@/lib/session";
import { apiError } from "@/lib/errors";
import { deriveDigestStage, episodeBasePath, listChunkStarts, deleteEpisodeFolder } from "@/lib/episodes";
import type { DigestStage } from "@/lib/episodes";

export const maxDuration = 30;

interface StatusResponse {
  episodeId: string | null;
  stage: DigestStage;
  totalLines: number;
  nextCursor: number;
  markdownReady: boolean;
  title?: string;
  createdAt?: string;
}

const NONE_RESPONSE: StatusResponse = {
  episodeId: null,
  stage: "none",
  totalLines: 0,
  nextCursor: 0,
  markdownReady: false,
};

interface EpisodeRow {
  id: string;
  status: string;
  script: unknown;
  markdown_path: string | null;
  audio_path: string | null;
  title: string | null;
  created_at: string;
}

/**
 * Looks up the episode to report on: a specific id (must belong to the
 * user), or with no id, the user's most recent 'draft' — draft is the only
 * status a resumable, in-progress generation can be in (see AGENTS.md pipeline).
 */
async function loadEpisode(userId: string, episodeId: string | null): Promise<EpisodeRow | null> {
  const columns = "id, status, script, markdown_path, audio_path, title, created_at";
  if (episodeId) {
    const { data, error } = await db()
      .from("episodes")
      .select(columns)
      .eq("user_id", userId)
      .eq("id", episodeId)
      .maybeSingle();
    if (error) throw new Error(`Episode lookup failed: ${error.message}`);
    return data as EpisodeRow | null;
  }
  const { data, error } = await db()
    .from("episodes")
    .select(columns)
    .eq("user_id", userId)
    .eq("status", "draft")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Draft lookup failed: ${error.message}`);
  return data as EpisodeRow | null;
}

async function buildStatus(userId: string, episodeId: string | null): Promise<StatusResponse | null> {
  const episode = await loadEpisode(userId, episodeId);
  if (!episode) return null;

  const scriptLength = Array.isArray(episode.script) ? episode.script.length : 0;

  // Only worth listing storage when there's a script to check chunk progress
  // against, and the episode isn't already finalized.
  const chunkStarts =
    episode.status !== "ready" && scriptLength > 0 && episode.markdown_path
      ? await listChunkStarts(episodeBasePath(episode.markdown_path))
      : [];

  const { stage, totalLines, nextCursor } = deriveDigestStage({
    status: episode.status,
    scriptLength,
    chunkStarts,
  });

  return {
    episodeId: episode.id,
    stage,
    totalLines,
    nextCursor,
    markdownReady: Boolean(episode.markdown_path),
    title: episode.title ?? undefined,
    createdAt: episode.created_at,
  };
}

async function handleStatus(userId: string, episodeId: string | null) {
  const status = await buildStatus(userId, episodeId);
  if (!status) {
    // An explicit id that doesn't resolve is a real 404; "no id, no draft" is
    // the normal steady state (nothing to resume) and isn't an error.
    if (episodeId) return NextResponse.json({ error: "Episode not found" }, { status: 404 });
    return NextResponse.json(NONE_RESPONSE);
  }
  return NextResponse.json(status);
}

// Stage-aware resume check. With no episodeId, reports the user's most recent
// resumable draft (if any); with one, reports that specific episode's stage.
export async function GET(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not logged in" }, { status: 401 });

  try {
    return await handleStatus(userId, req.nextUrl.searchParams.get("episodeId"));
  } catch (err) {
    return apiError("Digest status error", err, "Couldn't check brief status");
  }
}

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not logged in" }, { status: 401 });

  try {
    const body = (await req.json().catch(() => ({}))) as { episodeId?: string };
    return await handleStatus(userId, body.episodeId ?? null);
  } catch (err) {
    return apiError("Digest status error", err, "Couldn't check brief status");
  }
}

// Discard: the user chose not to resume. Removes the draft row and its
// storage folder (markdown + any rendered chunks) so it stops showing up as
// resumable. Only ever targets 'draft' episodes — finished briefs are
// deleted nowhere in this app today.
export async function DELETE(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not logged in" }, { status: 401 });

  const episodeId =
    req.nextUrl.searchParams.get("episodeId") ??
    ((await req.json().catch(() => ({}))) as { episodeId?: string }).episodeId;
  if (!episodeId) return NextResponse.json({ error: "episodeId required" }, { status: 400 });

  try {
    const { data: episode, error } = await db()
      .from("episodes")
      .select("id, status, markdown_path, audio_path")
      .eq("user_id", userId)
      .eq("id", episodeId)
      .maybeSingle();
    if (error) throw new Error(`Episode lookup failed: ${error.message}`);
    if (!episode) return NextResponse.json({ error: "Episode not found" }, { status: 404 });
    if (episode.status !== "draft") {
      return NextResponse.json({ error: "Only draft episodes can be discarded" }, { status: 400 });
    }

    if (episode.markdown_path) {
      await deleteEpisodeFolder(episodeBasePath(episode.markdown_path), [
        episode.markdown_path,
        episode.audio_path,
      ]);
    }

    const { error: delErr } = await db()
      .from("episodes")
      .delete()
      .eq("user_id", userId)
      .eq("id", episodeId);
    if (delErr) throw new Error(`Episode delete failed: ${delErr.message}`);

    return NextResponse.json({ deleted: true });
  } catch (err) {
    return apiError("Digest discard error", err, "Couldn't discard draft");
  }
}
