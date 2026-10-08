import "server-only";
import { lookup } from "dns/promises";
import { isIP } from "net";
import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";
import { db } from "./supabase";
import { grokJson, grokText, grokSearchText, FAST_MODEL } from "./grok";
import { getVoiceProviderForUser } from "./voice/user";
import type { VoiceProvider } from "./voice";
import type { ReferencedTweet } from "./x";

const ARTICLE_CHAR_CAP = 8000;
const TRANSCRIPT_CHAR_CAP = 8000;
const MAX_ARTICLES_PER_POST = 3;
const MAX_VIDEO_BYTES = 60 * 1024 * 1024;
const MAX_VIDEO_MINUTES = 25;
const ARTICLE_FETCH_TIMEOUT_MS = 15_000;
const MAX_ARTICLE_REDIRECTS = 5;

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

// Loopback/private/link-local IPv4 ranges, keyed off the leading
// dotted-decimal octets. Shared by the plain-hostname check below and by
// the IPv4-mapped-IPv6 check (::ffff:a.b.c.d), so both paths stay in sync.
function isPrivateIPv4(h: string): boolean {
  return (
    /^127\.|^10\.|^192\.168\.|^169\.254\.|^0\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  );
}

// URL.hostname wraps IPv6 literals in brackets ("[::1]"); dns.lookup()
// results and hand-written test literals don't. Accept either.
function stripBrackets(h: string): string {
  return h.length > 1 && h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}

/**
 * Expands a bracket-free IPv6 literal — "::1", "fe80::1", "::ffff:127.0.0.1",
 * the fully-expanded "0:0:0:0:0:0:0:1", etc. — into its 8 16-bit groups, or
 * returns null if `addr` isn't a well-formed IPv6 literal. Handles "::"
 * compression and a trailing embedded IPv4 dotted-decimal group.
 */
function parseIPv6Groups(addr: string): number[] | null {
  const base = addr.split("%")[0]; // drop a zone id ("fe80::1%eth0"), if present
  if (!base.includes(":")) return null;

  const halves = base.split("::");
  if (halves.length > 2) return null; // "::" may appear at most once

  const splitHextets = (s: string) => (s === "" ? [] : s.split(":"));
  const left = splitHextets(halves[0]);
  const right = halves.length === 2 ? splitHextets(halves[1]) : null;

  // A dotted-decimal IPv4 tail (e.g. "127.0.0.1") is only legal as the very
  // last group of the whole address — the end of `right` when "::" is
  // present, or of `left` otherwise.
  const expandV4Tail = (groups: string[]): string[] | null => {
    const last = groups[groups.length - 1];
    if (last === undefined || !last.includes(".")) return groups;
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(last);
    if (!m) return null;
    const bytes = m.slice(1).map(Number);
    if (bytes.some((b) => b > 255)) return null;
    const hi = ((bytes[0] << 8) | bytes[1]).toString(16);
    const lo = ((bytes[2] << 8) | bytes[3]).toString(16);
    return [...groups.slice(0, -1), hi, lo];
  };

  const expandedLeft = right === null ? expandV4Tail(left) : left;
  const expandedRight = right === null ? null : expandV4Tail(right);
  if (expandedLeft === null || (right !== null && expandedRight === null)) return null;

  const isHextet = (s: string) => /^[0-9a-f]{1,4}$/i.test(s);
  if (!expandedLeft.every(isHextet) || !(expandedRight ?? []).every(isHextet)) return null;

  if (expandedRight === null) {
    if (expandedLeft.length !== 8) return null; // no "::" means all 8 groups must be explicit
    return expandedLeft.map((g) => parseInt(g, 16));
  }
  const total = expandedLeft.length + expandedRight.length;
  if (total > 8) return null;
  const zeros = Array<number>(8 - total).fill(0);
  return [
    ...expandedLeft.map((g) => parseInt(g, 16)),
    ...zeros,
    ...expandedRight.map((g) => parseInt(g, 16)),
  ];
}

function isPrivateIPv6(addr: string): boolean {
  const groups = parseIPv6Groups(addr);
  if (!groups) return false;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;

  if (groups.every((g) => g === 0)) return true; // "::" (unspecified address)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) {
    return true; // "::1" (loopback)
  }
  if (g0 >= 0xfe80 && g0 <= 0xfebf) return true; // fe80::/10 (link-local)
  if (g0 >= 0xfc00 && g0 <= 0xfdff) return true; // fc00::/7 (unique local / ULA, covers fc00:: and fd00::)

  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) — defer to the IPv4 rules on the embedded address.
    const v4 = `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`;
    return isPrivateIPv4(v4);
  }

  return false;
}

export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || isPrivateIPv4(h)) {
    return true;
  }
  const stripped = stripBrackets(h);
  return stripped.includes(":") && isPrivateIPv6(stripped);
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

/**
 * SSRF guard for a single hop. Rejects hosts that are private/loopback/
 * link-local literals outright (string check, via isPrivateHost), and for
 * real hostnames also resolves DNS and rejects if ANY returned address is
 * private (blocks "public hostname, private A/AAAA record" bypasses).
 * IP-literal hosts skip the DNS step — the literal itself was already
 * checked above.
 *
 * Residual risk, intentionally not closed here: this is a TOCTOU check.
 * fetch()'s own internal DNS resolution happens a moment after this
 * lookup() returns, so a DNS-rebinding attacker who flips the record
 * between the two resolutions could still slip a private address past us.
 * Fully closing that gap means pinning the vetted IP and connecting to it
 * directly (a custom dispatcher/agent that bypasses fetch's own resolver) —
 * more infrastructure than this app's threat model (fetching URLs a user
 * bookmarked) warrants. The checks here still stop the realistic paths:
 * redirect-to-metadata-endpoint, public-hostname-with-private-DNS-record,
 * and IPv6/IPv4-mapped literal bypasses.
 */
async function assertHostIsSafe(target: URL): Promise<void> {
  const hostname = target.hostname;
  if (isPrivateHost(hostname)) {
    throw new Error(`Blocked private host: ${hostname}`);
  }

  const bare = stripBrackets(hostname);
  if (isIP(bare)) return; // IP literal — already fully checked above, no DNS needed

  const records = await lookup(bare, { all: true });
  for (const { address } of records) {
    if (isPrivateHost(address)) {
      throw new Error(`Blocked host resolving to private address: ${bare} -> ${address}`);
    }
  }
}

async function fetchArticle(url: string): Promise<{ title: string | null; content: string }> {
  const headers = {
    "User-Agent": "Mozilla/5.0 (compatible; BookmarkBrief/1.0; +https://github.com/im-trustworthy/x-bookmark)",
    Accept: "text/html,application/xhtml+xml",
  };
  const deadline = Date.now() + ARTICLE_FETCH_TIMEOUT_MS;
  const visited = new Set<string>();
  let current = new URL(url);
  let res!: Response;

  // Manual redirect loop: fetch() with redirect:"follow" would chase 3xx
  // hops itself without ever re-checking the new host, which is exactly
  // the SSRF bypass this function exists to close. So we take one hop at a
  // time and re-run the full host/DNS validation on every hop, including
  // the first.
  for (let redirects = 0; ; redirects++) {
    if (!/^https?:$/.test(current.protocol)) {
      throw new Error(`Blocked non-http(s) redirect target: ${current.toString()}`);
    }
    const key = current.toString();
    if (visited.has(key)) throw new Error("Redirect loop detected");
    visited.add(key);

    await assertHostIsSafe(current);

    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Article fetch timed out");

    res = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(remaining),
      headers,
    });

    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) break;
    if (redirects >= MAX_ARTICLE_REDIRECTS) throw new Error("Too many redirects");
    current = new URL(location, current);
  }

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
// Media: images via Grok vision, video via the configured voice provider's STT
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

async function transcribeVideo(media: XMedia, stt: VoiceProvider | null): Promise<{ url: string; content: string }> {
  const variants = (media.variants ?? [])
    .filter((v) => v.content_type === "video/mp4" && v.url && v.bit_rate != null)
    .sort((a, b) => (a.bit_rate ?? 0) - (b.bit_rate ?? 0));
  const variant = variants[0];
  if (!variant?.url) throw new Error("No mp4 variant");
  if ((media.duration_ms ?? 0) > MAX_VIDEO_MINUTES * 60_000) throw new Error("Video too long");
  // Checked before the download: with no usable provider the caller falls back
  // to the thumbnail without fetching the video for nothing.
  if (!stt) throw new Error("No voice provider for transcription");

  const videoRes = await fetch(variant.url, { signal: AbortSignal.timeout(60_000) });
  if (!videoRes.ok) throw new Error(`Video fetch ${videoRes.status}`);
  const bytes = await videoRes.arrayBuffer();
  if (bytes.byteLength > MAX_VIDEO_BYTES) throw new Error("Video too large");

  const text = await stt.transcribe(bytes, "video/mp4", "video.mp4");
  return { url: variant.url, content: text.slice(0, TRANSCRIPT_CHAR_CAP) };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function ingestOne(
  bookmark: {
    user_id: string;
    tweet_id: string;
    author_handle: string | null;
    text: string;
    entities: unknown;
    media: XMedia[] | null;
    referenced: ReferencedTweet[] | null;
  },
  stt: VoiceProvider | null
): Promise<SourceRow[]> {
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
        const { url, content } = await transcribeVideo(media, stt);
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

  // One provider for the whole batch (one settings read and key decrypt). A
  // missing or broken voice config isn't fatal: videos fall back to thumbnails.
  const stt = await getVoiceProviderForUser(userId).catch((err: unknown) => {
    console.error("Video transcription unavailable:", err);
    return null;
  });

  let done = 0;
  const queue = [...todo];
  await Promise.all(
    Array.from({ length: Math.min(3, queue.length) }, async () => {
      for (let b = queue.shift(); b; b = queue.shift()) {
        try {
          const rows = await ingestOne(b, stt);
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
