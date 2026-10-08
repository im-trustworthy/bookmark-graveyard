import "server-only";
import { db } from "./supabase";
import { grokJson, grokText, FAST_MODEL, SMART_MODEL } from "./grok";
import type { ReferencedTweet } from "./x";

// ---------------------------------------------------------------------------
// Enrichment: topics, summary, claims, news-vs-evergreen, credibility
// ---------------------------------------------------------------------------

interface EnrichmentResult {
  items: {
    tweet_id: string;
    topics: string[];
    summary: string;
    claims: string[];
    content_type: "news" | "evergreen" | "opinion" | "other";
  }[];
}

/**
 * Enriches bookmarks that have no analysis row yet, up to `limit` per call so
 * HTTP requests stay short — the client loops until `remaining` hits zero.
 * Uses the FAST model; includes ingested source material so topics/summaries
 * reflect the article/media substance, not just the post text.
 */
export async function enrichNewBookmarks(
  userId: string,
  limit = Infinity
): Promise<{ enriched: number; remaining: number }> {
  const { data: pending } = await db()
    .from("bookmarks")
    .select("tweet_id, author_handle, text, tweet_created_at, referenced, bookmark_analysis(tweet_id)")
    .eq("user_id", userId)
    .not("ingested_at", "is", null); // analyze only after sources are ingested
  const allTodo = (pending ?? []).filter((b) => {
    const a = b.bookmark_analysis;
    return !a || (Array.isArray(a) && a.length === 0);
  });
  const todo = allTodo.slice(0, limit);
  if (todo.length === 0) return { enriched: 0, remaining: 0 };

  const { data: topicRows } = await db().from("topics").select("name").eq("user_id", userId);
  let taxonomy = (topicRows ?? []).map((t) => t.name);

  const sourcesByTweet = await loadSources(userId, todo.map((b) => b.tweet_id));

  // Community Notes flags for these tweets (populated by the nightly public-dataset job)
  const { data: notes } = await db()
    .from("community_notes")
    .select("tweet_id, classification, status")
    .in("tweet_id", todo.map((b) => b.tweet_id));
  const credibilityFor = (tweetId: string): "none" | "disputed" | "misleading" => {
    const tweetNotes = (notes ?? []).filter((n) => n.tweet_id === tweetId);
    if (tweetNotes.length === 0) return "none";
    const misleading = tweetNotes.some(
      (n) =>
        n.classification === "MISINFORMED_OR_POTENTIALLY_MISLEADING" &&
        n.status === "CURRENTLY_RATED_HELPFUL"
    );
    return misleading ? "misleading" : "disputed";
  };

  const batches: (typeof todo)[] = [];
  for (let i = 0; i < todo.length; i += 20) batches.push(todo.slice(i, i + 20));

  let enriched = 0;
  const processBatch = async (batch: typeof todo) => {
    const result = await grokJson<EnrichmentResult>(
      FAST_MODEL,
      `You analyze a user's bookmarked X (Twitter) posts for a personal digest app.
For each post return: topics (1-3 tags), a one-sentence summary, key factual claims (0-3),
and content_type: "news" (time-sensitive events), "evergreen" (advice, ideas, resources that stay useful),
"opinion", or "other".
Base your analysis on ALL provided material (post, quoted post, linked article, media transcript/description).
Topic rules: STRONGLY prefer reusing tags from the existing taxonomy. Only coin a new tag when nothing fits.
Tags are short Title Case noun phrases like "AI Tools", "Startup Advice", "Health".
Existing taxonomy: ${JSON.stringify(taxonomy)}
Respond with JSON: {"items":[{"tweet_id","topics","summary","claims","content_type"}]}`,
      JSON.stringify(
        batch.map((b) => ({
          tweet_id: b.tweet_id,
          author: b.author_handle,
          posted: b.tweet_created_at,
          text: b.text,
          quoted: ((b.referenced ?? []) as ReferencedTweet[])
            .map((r) => r.text)
            .filter(Boolean)
            .join("\n")
            .slice(0, 1200) || undefined,
          sources: (sourcesByTweet.get(b.tweet_id) ?? [])
            .filter((s) => s.content)
            .map((s) => `[${s.kind}] ${s.title ?? ""} ${s.content!.slice(0, 800)}`),
        }))
      )
    );

    const valid = (result.items ?? []).filter((item) =>
      batch.some((b) => b.tweet_id === item.tweet_id)
    );
    if (valid.length === 0) return;

    const { error } = await db()
      .from("bookmark_analysis")
      .upsert(
        valid.map((item) => ({
          user_id: userId,
          tweet_id: item.tweet_id,
          topics: item.topics ?? [],
          summary: item.summary ?? null,
          claims: item.claims ?? [],
          content_type: ["news", "evergreen", "opinion", "other"].includes(item.content_type)
            ? item.content_type
            : "other",
          credibility: credibilityFor(item.tweet_id),
        }))
      );
    if (error) throw new Error(`Analysis upsert failed: ${error.message}`);
    enriched += valid.length;

    const newTopics = [...new Set(valid.flatMap((v) => v.topics ?? []))].filter(
      (t) => !taxonomy.includes(t)
    );
    if (newTopics.length > 0) {
      await db()
        .from("topics")
        .upsert(newTopics.map((name) => ({ user_id: userId, name })));
      taxonomy = [...taxonomy, ...newTopics];
    }
  };

  // Concurrency pool of 3 Grok calls; a failed batch stays pending for the next pass.
  const queue = [...batches];
  await Promise.all(
    Array.from({ length: Math.min(3, queue.length) }, async () => {
      for (let batch = queue.shift(); batch; batch = queue.shift()) {
        try {
          await processBatch(batch);
        } catch (err) {
          console.error("Enrichment batch failed:", err);
        }
      }
    })
  );

  return { enriched, remaining: allTodo.length - enriched };
}

// ---------------------------------------------------------------------------
// Dossiers: everything we know about a bookmark, assembled for synthesis
// ---------------------------------------------------------------------------

export interface DigestBookmark {
  tweet_id: string;
  author_handle: string | null;
  author_name: string | null;
  text: string;
  tweet_created_at: string | null;
  topics: string[];
  summary: string | null;
  content_type: string;
  credibility: string;
  referenced: ReferencedTweet[];
}

interface SourceRow {
  tweet_id: string;
  kind: string;
  url: string;
  title: string | null;
  content: string | null;
}

async function loadSources(userId: string, tweetIds: string[]): Promise<Map<string, SourceRow[]>> {
  const map = new Map<string, SourceRow[]>();
  if (tweetIds.length === 0) return map;
  const { data } = await db()
    .from("bookmark_sources")
    .select("tweet_id, kind, url, title, content")
    .eq("user_id", userId)
    .eq("status", "ok")
    .in("tweet_id", tweetIds);
  for (const row of data ?? []) {
    const list = map.get(row.tweet_id) ?? [];
    list.push(row);
    map.set(row.tweet_id, list);
  }
  return map;
}

export function postUrl(b: { author_handle: string | null; tweet_id: string }): string {
  return `https://x.com/${b.author_handle ?? "i"}/status/${b.tweet_id}`;
}

/** One self-contained text block per bookmark: post + quotes + articles + media. */
function buildDossier(
  b: DigestBookmark,
  sources: SourceRow[],
  extra: { caveats: string[] }
): string {
  const lines: string[] = [
    `### POST ${b.tweet_id}`,
    `Author: ${b.author_name ?? "Unknown"} (@${b.author_handle ?? "unknown"})`,
    `URL: ${postUrl(b)}`,
    `Posted: ${b.tweet_created_at ?? "unknown"}`,
    ...(extra.caveats.length ? [`Caveats: ${extra.caveats.join("; ")}`] : []),
    `Post text: ${b.text}`,
  ];
  for (const ref of b.referenced ?? []) {
    if (ref.text) {
      lines.push(
        `${ref.type === "quoted" ? "Quoted post" : "In reply to"} ${
          ref.author_handle ? `by @${ref.author_handle}` : ""
        }: ${ref.text.slice(0, 1500)}`
      );
    }
  }
  for (const s of sources) {
    if (!s.content) continue;
    if (s.kind === "article") {
      lines.push(`Linked article "${s.title ?? s.url}" (${s.url}): ${s.content.slice(0, 4000)}`);
    } else if (s.kind === "video") {
      lines.push(`Video ${s.title ?? "transcript"}: ${s.content.slice(0, 3000)}`);
    } else {
      lines.push(`Image content: ${s.content.slice(0, 1200)}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Selection + staleness
// ---------------------------------------------------------------------------

export interface DigestFilters {
  from?: string;
  to?: string;
  topics?: string[];
  /** Explicit hand-picked selection; when set, date/topic filters don't apply. */
  tweetIds?: string[];
}

export async function selectBookmarksForDigest(
  userId: string,
  filters: DigestFilters
): Promise<{ included: DigestBookmark[]; excludedAsMisleading: DigestBookmark[] }> {
  let query = db()
    .from("bookmarks")
    .select(
      "tweet_id, author_handle, author_name, text, tweet_created_at, referenced, bookmark_analysis(topics, summary, content_type, credibility)"
    )
    .eq("user_id", userId)
    .eq("hidden", false)
    .order("tweet_created_at", { ascending: false, nullsFirst: false });
  if (filters.tweetIds && filters.tweetIds.length > 0) {
    query = query.in("tweet_id", filters.tweetIds);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  // Date filter matches the browse list: the post's date, keeping undated posts.
  const useDates = !filters.tweetIds?.length;
  const toBound = filters.to ? `${filters.to}T23:59:59Z` : null;
  const dateFiltered = (data ?? []).filter((b) => {
    if (!useDates || !b.tweet_created_at) return true;
    if (filters.from && b.tweet_created_at < filters.from) return false;
    if (toBound && b.tweet_created_at > toBound) return false;
    return true;
  });

  const rows: DigestBookmark[] = dateFiltered.map((b) => {
    const a = Array.isArray(b.bookmark_analysis) ? b.bookmark_analysis[0] : b.bookmark_analysis;
    return {
      tweet_id: b.tweet_id,
      author_handle: b.author_handle,
      author_name: b.author_name,
      text: b.text,
      tweet_created_at: b.tweet_created_at,
      referenced: (b.referenced ?? []) as ReferencedTweet[],
      topics: a?.topics ?? [],
      summary: a?.summary ?? null,
      content_type: a?.content_type ?? "other",
      credibility: a?.credibility ?? "none",
    };
  });

  const topicFiltered =
    useDates && filters.topics && filters.topics.length > 0
      ? rows.filter((r) => r.topics.some((t) => filters.topics!.includes(t)))
      : rows;

  return {
    included: topicFiltered.filter((r) => r.credibility !== "misleading"),
    excludedAsMisleading: topicFiltered.filter((r) => r.credibility === "misleading"),
  };
}

interface StalenessResult {
  items: { tweet_id: string; verdict: "keep" | "stale" | "evolved" }[];
}

/** At digest time, drop stale news and mark items that have likely moved on. */
export async function stalenessPass(
  bookmarks: DigestBookmark[]
): Promise<Map<string, "keep" | "stale" | "evolved">> {
  const verdicts = new Map<string, "keep" | "stale" | "evolved">();
  const newsItems = bookmarks.filter((b) => b.content_type === "news");
  for (const b of bookmarks) verdicts.set(b.tweet_id, "keep");
  if (newsItems.length === 0) return verdicts;

  const today = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < newsItems.length; i += 25) {
    const batch = newsItems.slice(i, i + 25);
    const result = await grokJson<StalenessResult>(
      FAST_MODEL,
      `Today is ${today}. For each time-sensitive post, judge its relevance for a weekly digest:
"keep" = still relevant/interesting, "stale" = old news with no remaining value,
"evolved" = worth mentioning but the story has likely developed since (digest should caveat it).
Respond with JSON: {"items":[{"tweet_id","verdict"}]}`,
      JSON.stringify(
        batch.map((b) => ({
          tweet_id: b.tweet_id,
          posted: b.tweet_created_at,
          summary: b.summary ?? b.text.slice(0, 300),
        }))
      )
    );
    for (const item of result.items ?? []) {
      if (["keep", "stale", "evolved"].includes(item.verdict)) {
        verdicts.set(item.tweet_id, item.verdict);
      }
    }
  }
  return verdicts;
}

// ---------------------------------------------------------------------------
// Digest: outline (SMART) -> compose (SMART), grounded in full dossiers
// ---------------------------------------------------------------------------

interface Outline {
  overview: string;
  sections: { title: string; tweet_ids: string[]; angle: string }[];
}

export async function writeMarkdownDigest(
  userId: string,
  bookmarks: DigestBookmark[],
  verdicts: Map<string, "keep" | "stale" | "evolved">,
  excluded: DigestBookmark[],
  dateRange: { from?: string; to?: string }
): Promise<string> {
  const kept = bookmarks.filter((b) => verdicts.get(b.tweet_id) !== "stale");
  const sourcesByTweet = await loadSources(userId, kept.map((b) => b.tweet_id));

  const dossiers = kept.map((b) =>
    buildDossier(b, sourcesByTweet.get(b.tweet_id) ?? [], {
      caveats: [
        b.credibility === "disputed"
          ? "has a pending/unrated Community Note — treat claims with care"
          : "",
        verdicts.get(b.tweet_id) === "evolved"
          ? "story has likely developed since this was posted"
          : "",
      ].filter(Boolean),
    })
  );

  // Stage 1 — outline: group posts into a narrative structure before writing.
  const outline = await grokJson<Outline>(
    SMART_MODEL,
    `You are the editorial planner for a personal weekly digest built from the reader's own X bookmarks.
Given post dossiers (post + quoted posts + linked articles + media transcripts), design the digest structure:
- 3-7 thematic sections; group related posts even across topics; strongest material first
- Every post must appear in exactly one section
- For each section give an "angle": the through-line or insight connecting its posts (1-2 sentences)
- "overview": 2-3 sentences capturing the week's big threads
Respond with JSON: {"overview": string, "sections":[{"title", "tweet_ids": string[], "angle"}]}`,
    dossiers.join("\n\n")
  );

  const sectionForId = new Map<string, string>();
  for (const s of outline.sections ?? []) {
    for (const id of s.tweet_ids ?? []) sectionForId.set(id, s.title);
  }
  const orphans = kept.filter((b) => !sectionForId.has(b.tweet_id));

  // Stage 2 — compose: write the digest section by section, grounded in dossiers.
  const composePayload = {
    dateRange,
    overview: outline.overview,
    sections: (outline.sections ?? []).map((s) => ({
      title: s.title,
      angle: s.angle,
      dossiers: (s.tweet_ids ?? [])
        .map((id) => dossiers[kept.findIndex((b) => b.tweet_id === id)])
        .filter(Boolean),
    })),
    unplaced: orphans.map((b) => buildDossier(b, sourcesByTweet.get(b.tweet_id) ?? [], { caveats: [] })),
    excluded: excluded.map((b) => ({ url: postUrl(b), author: `@${b.author_handle}` })),
  };

  return grokText(
    SMART_MODEL,
    `You write the reader's personal weekly brief for Bookmark Graveyard, in markdown, from their own X bookmarks.
Follow the provided outline exactly (sections, order, angles). Rules:
- Start with "# Your weekly brief" + the date range, then the overview paragraph.
- One "## <Section title>" per outline section. SYNTHESIZE the dossiers into flowing insight along the
  section's angle — weave posts together, don't list them. Draw on the article excerpts and transcripts,
  not just post text; pull out the sharpest specific facts, numbers, and takeaways.
- ATTRIBUTION IS MANDATORY: every idea is credited inline to its creator as a markdown link on the
  creator's name — format: [Author Name (@handle)](post URL). Every post in a section must be cited.
  When a linked article has a different author/publication, name it in prose ("writing in ...").
- Mention caveats naturally where they exist (disputed notes, evolved stories).
- Place any "unplaced" dossiers in the most fitting section.
- End with "## Worth a deeper look" — the 3 most substantive items with one-line reasons.
${composePayload.excluded.length > 0 ? `- Then add "## Excluded as disputed": one line per omitted post (Community Notes rated them misleading), links only.` : ""}
- Tone: smart, warm, specific. No filler, no hype.`,
    JSON.stringify(composePayload),
    { temperature: 0.5 }
  );
}

// ---------------------------------------------------------------------------
// Podcast script
// ---------------------------------------------------------------------------

export interface ScriptLine {
  speaker: "A" | "B";
  line: string;
}

/** Two-host dialogue script from the markdown digest. ~150 wpm spoken. */
export async function writePodcastScript(
  markdown: string,
  targetMinutes: number
): Promise<ScriptLine[]> {
  const wordBudget = Math.min(targetMinutes, 30) * 150;
  const result = await grokJson<{ lines: ScriptLine[] }>(
    SMART_MODEL,
    `You write a two-host podcast script from a digest of the listener's own X bookmarks.
Host A ("Alex") is curious and steers the show; Host B ("Blake") is the analyst who adds depth.
Style: NotebookLM-like — conversational, enthusiastic but not cheesy, hosts build on each other,
react briefly, ask each other real questions. Open by welcoming the listener to their weekly
Bookmark Graveyard brief; close with a quick recap.
CREDIT CREATORS BY NAME: whenever discussing a post's content, the hosts say the creator's actual
name naturally in speech ("Sarah Chen made a great point about...", "there's a thread from Naval on...").
Never read out URLs or @-handles letter by letter; use the human name (fall back to the handle as a
spoken word). Credit article authors/publications the same way when the material comes from an article.
Total length: about ${wordBudget} words (${Math.min(targetMinutes, 30)} minutes at 150 wpm) — do not exceed it.
Respond with JSON: {"lines":[{"speaker":"A"|"B","line":"..."}]}`,
    markdown
  );
  return (result.lines ?? []).filter(
    (l) => (l.speaker === "A" || l.speaker === "B") && typeof l.line === "string" && l.line.trim()
  );
}
