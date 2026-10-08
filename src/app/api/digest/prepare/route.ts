import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { getSessionUserId } from "@/lib/session";
import {
  selectBookmarksForDigest,
  stalenessPass,
  writeMarkdownDigest,
} from "@/lib/brain";
import { signEpisodeUrls } from "@/lib/episodes";
import { checkUsage } from "@/lib/limits";
import { apiError } from "@/lib/errors";
import { isTtsReady, VoiceConfigError } from "@/lib/voice";
import type { VoiceConfig } from "@/lib/voice";
import { resolveVoiceConfigForUser } from "@/lib/voice/user";

export const maxDuration = 300;

interface PrepareRequest {
  // "audio" requests are normalized to "both" in validatePrepareBody, so only these two are ever stored.
  format: "markdown" | "both";
  from?: string;
  to?: string;
  topics?: string[];
  tweetIds?: string[];
  targetMinutes?: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TWEET_IDS = 500;

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * Lightweight hand-rolled validation (no schema lib) — the request shape is
 * small and fixed, so a few explicit checks are clearer than a dependency.
 */
function validatePrepareBody(body: unknown): { value: PrepareRequest } | { error: string } {
  if (!body || typeof body !== "object") return { error: "Invalid request body" };
  const b = body as Record<string, unknown>;

  if (b.from !== undefined && (typeof b.from !== "string" || !DATE_RE.test(b.from))) {
    return { error: "from must be a YYYY-MM-DD date" };
  }
  if (b.to !== undefined && (typeof b.to !== "string" || !DATE_RE.test(b.to))) {
    return { error: "to must be a YYYY-MM-DD date" };
  }
  if (b.topics !== undefined && !isStringArray(b.topics)) {
    return { error: "topics must be an array of strings" };
  }
  if (b.tweetIds !== undefined) {
    if (!isStringArray(b.tweetIds)) return { error: "tweetIds must be an array of strings" };
    if (b.tweetIds.length > MAX_TWEET_IDS) {
      return { error: `tweetIds cannot exceed ${MAX_TWEET_IDS} items` };
    }
  }
  if (b.targetMinutes !== undefined && typeof b.targetMinutes !== "number") {
    return { error: "targetMinutes must be a number" };
  }

  // The server still accepts "markdown", "audio" and "both". "audio" behaves as "both": the markdown is
  // produced first either way and the podcast script is derived from it, so audio-only was never really
  // audio-only. The picker no longer offers it, but old clients may still send it. Anything else
  // unrecognised also falls back to "both".
  const format: PrepareRequest["format"] = b.format === "markdown" ? "markdown" : "both";

  return {
    value: {
      format,
      from: b.from as string | undefined,
      to: b.to as string | undefined,
      topics: b.topics as string[] | undefined,
      tweetIds: b.tweetIds as string[] | undefined,
      targetMinutes: b.targetMinutes as number | undefined,
    },
  };
}

// Stage 1: select -> freshness -> outline -> compose markdown. For markdown-only
// briefs this completes the episode; for audio the client continues to /script.
export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not logged in" }, { status: 401 });

  const rawBody = await req.json().catch(() => null);
  const validated = validatePrepareBody(rawBody);
  if ("error" in validated) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }
  const body = validated.value;
  const format = body.format;

  try {
    // Before any paid work: without a voice provider an audio brief would burn
    // a digest_prepare slot and the Grok writing pass, then fail at /render.
    let voice: VoiceConfig | null = null;
    if (format === "both") {
      try {
        voice = await resolveVoiceConfigForUser(userId);
      } catch (err) {
        // A broken voice setup names the setting to fix (never a secret): the same 400 as "none".
        if (err instanceof VoiceConfigError) return apiError("Digest prepare error", err, err.message, 400);
        throw err;
      }
      if (!isTtsReady(voice)) {
        // Non-null but not ready means ElevenLabs with a key and no host voices (Grok voices have defaults).
        const message = voice
          ? "ElevenLabs voices aren't set — choose voices under Voices, or set ELEVENLABS_VOICE_HOST_A and ELEVENLABS_VOICE_HOST_B on the server"
          : "Audio briefs need a voice provider — connect Grok Voice or ElevenLabs under Voices, or set VOICE_PROVIDER on the server, or choose a markdown-only brief";
        return apiError("Digest prepare error", message, message, 400);
      }
    }

    const { included, excludedAsMisleading } = await selectBookmarksForDigest(userId, body);
    if (included.length === 0) {
      return NextResponse.json(
        { error: "No bookmarks match these filters. Try widening the date range or syncing first." },
        { status: 400 }
      );
    }

    // Gates the whole pipeline: script/render/finalize don't re-check, so a
    // resumed generation never burns another slot — only fresh briefs do.
    // Checked after the (free, DB-only) selection so empty-filter misses don't
    // consume a daily slot, but before the first paid Grok call below.
    await checkUsage(userId, "digest_prepare");

    const verdicts = await stalenessPass(included);
    const markdown = await writeMarkdownDigest(userId, included, verdicts, excludedAsMisleading, {
      from: body.from,
      to: body.to,
    });

    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const markdownPath = `${userId}/${stamp}/brief.md`;
    const { error: mdErr } = await db()
      .storage.from("episodes")
      .upload(markdownPath, Buffer.from(markdown, "utf8"), { contentType: "text/markdown" });
    if (mdErr) throw new Error(`Markdown upload failed: ${mdErr.message}`);

    const dropped = included.filter((b) => verdicts.get(b.tweet_id) === "stale").length;
    const markdownOnly = format === "markdown";
    const title = `Bookmark Brief — ${new Date().toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    })}`;

    const { data: episode, error: epErr } = await db()
      .from("episodes")
      .insert({
        user_id: userId,
        title,
        format,
        status: markdownOnly ? "ready" : "draft",
        date_from: body.from ?? null,
        date_to: body.to ?? null,
        topics: body.topics ?? [],
        markdown_path: markdownPath,
        bookmark_count: included.length - dropped,
        // Pin the voices this brief starts with, so a resumed render finishes in them.
        voice: voice ? { provider: voice.provider, voiceA: voice.voiceA, voiceB: voice.voiceB } : null,
      })
      .select()
      .single();
    if (epErr) throw new Error(`Episode save failed: ${epErr.message}`);

    return NextResponse.json({
      episode: await signEpisodeUrls(episode),
      markdown,
      done: markdownOnly,
      stats: {
        considered: included.length,
        droppedAsStale: dropped,
        excludedAsMisleading: excludedAsMisleading.length,
      },
    });
  } catch (err) {
    return apiError("Digest prepare error", err, "Digest generation failed");
  }
}
