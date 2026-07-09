import "server-only";
import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";
import { db } from "./supabase";
import { env } from "./env";
import { grokJson, grokText, grokSearchText, FAST_MODEL } from "./grok";
import type { ReferencedTweet } from "./x";

const ARTICLE_CHAR_CAP = 8000;
const TRANSCRIPT_CHAR_CAP = 8000;
const MAX_ARTICLES_PER_POST = 3;
const MAX_VIDEO_BYTES = 60 * 1024 * 1024;
const MAX_VIDEO_MINUTES = 25;

interface SourceRow {
  user_id: string;
  tweet_id: string;
  kind: "article" | "image" | "video";
  url: string;
  title: string | null;
  content: string | null;
  status: "ok" | "failed" | "skipped";
}

// ---------------------------------------------------------------------------
// Articles
// ---------------------------------------------------------------------------

export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === "localhost" ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    /^127\.|^10\.|^192\.168\.|^169\.254\.|^0\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    h === "::1"
  );
}

export function extractArticleUrls(entities: unknown, referenced: ReferencedTweet[]): string[] {
  const urls: string[] = [];
  const fromEntities = (e: unknown) => {
    const list =
      (e as { urls?: { expanded_url?: string; unwound_url?: string; url?: string }[] })?.urls ?? [];
    for (const u of list) {
      const url = u.unwound_url ?? u.expanded_url ?? u.url;
      if (url) urls.push(url);
    }
  };
  fromEntities(entities);
  // links inside quoted posts count as referenced material too
  for (const ref of referenced) {
    const m = (ref.text ?? "").match(/https?:\/\/\S+/g);
    if (m) urls.push(...m);
  }
  return [...new Set(urls)]
    .filter((u) => {
      try {
        const parsed = new URL(u);
        if (!/^https?:$/.test(parsed.protocol) || isPrivateHost(parsed.hostname)) return false;
        // X-internal links (quote/status/media) aren't articles
        return !/(^|\.)((x|twitter)\.com|t\.co|pic\.twitter\.com)$/i.test(parsed.hostname);
      } catch {
        return false;
      }
    })
    .slice(0, MAX_ARTICLES_PER_POST);
}

async function fetchArticle(url: string): Promise<{ title: string | null; content: string }> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; BookmarkBrief/1.0; +https://github.com/im-trustworthy/x-bookmark)",
      Accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("html")) throw new Error(`Not HTML (${type})`);
  const html = (await res.text()).slice(0, 2_000_000);

  const virtualConsole = new VirtualConsole(); // swallow CSS-parse noise from real-world pages
  const dom = new JSDOM(html, { url, virtualConsole });
  const article = new Readability(dom.window.document).parse();
  const content = (article?.textContent ?? "").replace(/\s+/g, " ").trim();
  if (content.length < 200) throw new Error("No extractable article body");
  return { title: article?.title ?? null, content: content.slice(0, ARTICLE_CHAR_CAP) };
}

/**
 * "Link below 👇" pattern: the article lives in the author's reply, which the
 * bookmarks API can't see. Best-effort: ask Grok (with live X search) to locate
 * it, then verify the fetched article actually matches what the post promised.
 */
async function findArticleViaLiveSearch(
  postUrl: string,
  authorHandle: string | null,
  text: string
): Promise<string | null> {
  try {
    const answer = await grokSearchText(
      `You find the exact article/external link an X author shared in the replies of their own post.
Search X for the post and its replies. Only report a URL you are confident the AUTHOR themselves posted
(usually the first self-reply). Reply with ONLY the URL, or the word NONE.`,
      `Post by @${authorHandle}: "${text.slice(0, 800)}"\nPost URL: ${postUrl}`
    );
    const match = answer.match(/https?:\/\/\S+/);
    return match ? match[0].replace(/[).,]+$/, "") : null;
  } catch (err) {
    console.error("x_search article lookup failed:", err);
    return null;
  }
}

async function verifyArticleMatches(
  postText: string,
  articleTitle: string | null,
  articleContent: string
): Promise<boolean> {
  try {
    const verdict = await grokJson<{ match: boolean }>(
      FAST_MODEL,
      `Does this article appear to be the one the post is referring to (same story/topic/resource)? Respond JSON {"match": boolean}.`,
      JSON.stringify({
        post: postText.slice(0, 600),
        articleTitle,
        articleStart: articleContent.slice(0, 800),
      })
    );
    return verdict.match === true;
  } catch {
    return true; // verification is a nice-to-have; don't drop content over it
  }
}

// ---------------------------------------------------------------------------
// Media: images via Grok vision, video via ElevenLabs Scribe
// ---------------------------------------------------------------------------

interface XMedia {
  type?: string;
  url?: string;
  preview_image_url?: string;
  alt_text?: string;
  duration_ms?: number;
  variants?: { bit_rate?: number; content_type?: string; url?: string }[];
}

async function describeImage(imageUrl: string, altText?: string): Promise<string> {
  return grokText(
    FAST_MODEL,
    "You extract information from images for a text-only digest. Describe the image's substance concisely; transcribe ALL legible text verbatim (tables/code included). Skip aesthetic commentary.",
    [
      { type: "image_url", image_url: { url: imageUrl } },
      { type: "text", text: `Extract the information in this image.${altText ? ` Author's alt text: ${altText}` : ""}` },
    ]
  );
}

async function transcribeVideo(media: XMedia): Promise<{ url: string; content: string }> {
  const variants = (media.variants ?? [])
    .filter((v) => v.content_type === "video/mp4" && v.url && v.bit_rate != null)
    .sort((a, b) => (a.bit_rate ?? 0) - (b.bit_rate ?? 0));
  const variant = variants[0];
  if (!variant?.url) throw new Error("No mp4 variant");
  if ((media.duration_ms ?? 0) > MAX_VIDEO_MINUTES * 60_000) throw new Error("Video too long");

  const videoRes = await fetch(variant.url, { signal: AbortSignal.timeout(60_000) });
  if (!videoRes.ok) throw new Error(`Video fetch ${videoRes.status}`);
  const bytes = await videoRes.arrayBuffer();
  if (bytes.byteLength > MAX_VIDEO_BYTES) throw new Error("Video too large");

  const form = new FormData();
  form.append("model_id", "scribe_v1");
  form.append("file", new Blob([bytes], { type: "video/mp4" }), "video.mp4");
  const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": env("ELEVENLABS_API_KEY") },
    body: form,
    signal: AbortSignal.timeout(240_000),
  });
  if (!res.ok) throw new Error(`Scribe failed (${res.status}): ${await res.text()}`);
  const body = (await res.json()) as { text?: string };
  const text = (body.text ?? "").trim();
  if (!text) throw new Error("Empty transcript");
  return { url: variant.url, content: text.slice(0, TRANSCRIPT_CHAR_CAP) };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function ingestOne(bookmark: {
  user_id: string;
  tweet_id: string;
  author_handle: string | null;
  text: string;
  entities: unknown;
  media: XMedia[] | null;
  referenced: ReferencedTweet[] | null;
}): Promise<SourceRow[]> {
  const rows: SourceRow[] = [];
  const base = { user_id: bookmark.user_id, tweet_id: bookmark.tweet_id };

  // 1. Directly linked articles (post + quoted post)
  let articleUrls = extractArticleUrls(bookmark.entities, bookmark.referenced ?? []);

  // 2. "Link in reply" pattern — only when the post advertises a link we can't see
  if (
    articleUrls.length === 0 &&
    /link (below|in (the )?(replies|reply|thread|comments))|🔗|👇|full (article|story|post|write.?up)/i.test(
      bookmark.text
    )
  ) {
    const postUrl = `https://x.com/${bookmark.author_handle ?? "i"}/status/${bookmark.tweet_id}`;
    const found = await findArticleViaLiveSearch(postUrl, bookmark.author_handle, bookmark.text);
    if (found) articleUrls = extractArticleUrls({ urls: [{ expanded_url: found }] }, []);
  }

  for (const url of articleUrls) {
    try {
      const article = await fetchArticle(url);
      const matches = await verifyArticleMatches(bookmark.text, article.title, article.content);
      rows.push({
        ...base,
        kind: "article",
        url,
        title: article.title,
        content: matches ? article.content : null,
        status: matches ? "ok" : "skipped",
      });
    } catch (err) {
      rows.push({ ...base, kind: "article", url, title: null, content: null, status: "failed" });
      console.error(`Article ingest failed (${url}):`, err);
    }
  }

  // 3. Media
  for (const media of bookmark.media ?? []) {
    if (media.type === "photo" && media.url) {
      try {
        const description = await describeImage(media.url, media.alt_text);
        rows.push({ ...base, kind: "image", url: media.url, title: null, content: description, status: "ok" });
      } catch (err) {
        rows.push({ ...base, kind: "image", url: media.url, title: null, content: null, status: "failed" });
        console.error("Image ingest failed:", err);
      }
    } else if (media.type === "video" || media.type === "animated_gif") {
      const fallbackUrl = media.preview_image_url ?? `video:${bookmark.tweet_id}`;
      try {
        const { url, content } = await transcribeVideo(media);
        rows.push({ ...base, kind: "video", url, title: "transcript", content, status: "ok" });
      } catch (err) {
        console.error("Video transcription skipped:", err);
        // Fall back to reading the thumbnail so the digest at least knows what the video shows
        if (media.preview_image_url) {
          try {
            const description = await describeImage(media.preview_image_url, media.alt_text);
            rows.push({
              ...base,
              kind: "video",
              url: fallbackUrl,
              title: "thumbnail description (no transcript)",
              content: description,
              status: "ok",
            });
            continue;
          } catch {}
        }
        rows.push({ ...base, kind: "video", url: fallbackUrl, title: null, content: null, status: "failed" });
      }
    }
  }

  return rows;
}

/** Ingests source material for bookmarks not yet processed. Client loops on remaining. */
export async function ingestPending(
  userId: string,
  limit = Infinity
): Promise<{ ingested: number; remaining: number }> {
  const { data } = await db()
    .from("bookmarks")
    .select("user_id, tweet_id, author_handle, text, entities, media, referenced")
    .eq("user_id", userId)
    .is("ingested_at", null)
    .order("first_seen_at", { ascending: false });
  const all = data ?? [];
  const todo = all.slice(0, limit);
  if (todo.length === 0) return { ingested: 0, remaining: 0 };

  let done = 0;
  const queue = [...todo];
  await Promise.all(
    Array.from({ length: Math.min(3, queue.length) }, async () => {
      for (let b = queue.shift(); b; b = queue.shift()) {
        try {
          const rows = await ingestOne(b);
          if (rows.length > 0) {
            const { error } = await db().from("bookmark_sources").upsert(rows);
            if (error) throw new Error(error.message);
          }
          await db()
            .from("bookmarks")
            .update({ ingested_at: new Date().toISOString() })
            .eq("user_id", userId)
            .eq("tweet_id", b.tweet_id);
          done++;
        } catch (err) {
          console.error(`Ingest failed for ${b.tweet_id}:`, err);
          // Mark done anyway — a permanently broken link shouldn't wedge the pipeline
          await db()
            .from("bookmarks")
            .update({ ingested_at: new Date().toISOString() })
            .eq("user_id", userId)
            .eq("tweet_id", b.tweet_id);
          done++;
        }
      }
    })
  );

  return { ingested: done, remaining: all.length - done };
}
