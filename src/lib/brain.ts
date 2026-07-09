import OpenAI from "openai";
import { db } from "./supabase";
import { env } from "./env";

// xAI's API is OpenAI-compatible.
function grok(): OpenAI {
  return new OpenAI({ apiKey: env("XAI_API_KEY"), baseURL: "https://api.x.ai/v1" });
}

const MODEL = process.env.XAI_MODEL ?? "grok-4";

async function grokJson<T>(system: string, user: string): Promise<T> {
  const res = await grok().chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
    temperature: 0.3,
  });
  const content = res.choices[0]?.message?.content ?? "{}";
  return JSON.parse(content) as T;
}

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
 * Batches of 20 posts per Grok call, 3 calls in flight at a time.
 */
export async function enrichNewBookmarks(
  userId: string,
  limit = Infinity
): Promise<{ enriched: number; remaining: number }> {
  const { data: pending } = await db()
    .from("bookmarks")
    .select("tweet_id, author_handle, text, tweet_created_at, bookmark_analysis(tweet_id)")
    .eq("user_id", userId);
  const allTodo = (pending ?? []).filter((b) => {
    const a = b.bookmark_analysis;
    return !a || (Array.isArray(a) && a.length === 0);
  });
  const todo = allTodo.slice(0, limit);
  if (todo.length === 0) return { enriched: 0, remaining: 0 };

  const { data: topicRows } = await db().from("topics").select("name").eq("user_id", userId);
  let taxonomy = (topicRows ?? []).map((t) => t.name);

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
      `You analyze a user's bookmarked X (Twitter) posts for a personal digest app.
For each post return: topics (1-3 tags), a one-sentence summary, key factual claims (0-3),
and content_type: "news" (time-sensitive events), "evergreen" (advice, ideas, resources that stay useful),
"opinion", or "other".
Topic rules: STRONGLY prefer reusing tags from the existing taxonomy. Only coin a new tag when nothing fits.
Tags are short Title Case noun phrases like "AI Tools", "Startup Advice", "Health".
Existing taxonomy: ${JSON.stringify(taxonomy)}
Respond with JSON: {"items":[{"tweet_id","topics","summary","claims","content_type"}]}`,
      JSON.stringify(
        batch.map((b) => ({
          tweet_id: b.tweet_id,
          author: b.author_handle,
          posted: b.tweet_created_at,
          text: b.text.slice(0, 2000),
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
// Digest: staleness pass + markdown + two-host script
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
}

export interface DigestFilters {
  from?: string;
  to?: string;
  topics?: string[];
}

export async function selectBookmarksForDigest(
  userId: string,
  filters: DigestFilters
): Promise<{ included: DigestBookmark[]; excludedAsMisleading: DigestBookmark[] }> {
  let query = db()
    .from("bookmarks")
    .select(
      "tweet_id, author_handle, author_name, text, tweet_created_at, bookmark_analysis(topics, summary, content_type, credibility)"
    )
    .eq("user_id", userId)
    .order("first_seen_at", { ascending: false });
  if (filters.from) query = query.gte("first_seen_at", filters.from);
  if (filters.to) query = query.lte("first_seen_at", `${filters.to}T23:59:59Z`);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const rows: DigestBookmark[] = (data ?? []).map((b) => {
    const a = Array.isArray(b.bookmark_analysis) ? b.bookmark_analysis[0] : b.bookmark_analysis;
    return {
      tweet_id: b.tweet_id,
      author_handle: b.author_handle,
      author_name: b.author_name,
      text: b.text,
      tweet_created_at: b.tweet_created_at,
      topics: a?.topics ?? [],
      summary: a?.summary ?? null,
      content_type: a?.content_type ?? "other",
      credibility: a?.credibility ?? "none",
    };
  });

  const topicFiltered =
    filters.topics && filters.topics.length > 0
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

export async function writeMarkdownDigest(
  bookmarks: DigestBookmark[],
  verdicts: Map<string, "keep" | "stale" | "evolved">,
  excluded: DigestBookmark[],
  dateRange: { from?: string; to?: string }
): Promise<string> {
  const kept = bookmarks.filter((b) => verdicts.get(b.tweet_id) !== "stale");
  const payload = kept.map((b) => ({
    url: `https://x.com/${b.author_handle ?? "i"}/status/${b.tweet_id}`,
    author: b.author_name ? `${b.author_name} (@${b.author_handle})` : `@${b.author_handle}`,
    posted: b.tweet_created_at,
    topics: b.topics,
    summary: b.summary,
    text: b.text.slice(0, 1500),
    caveats: [
      b.credibility === "disputed" ? "has a pending/unrated Community Note — treat with care" : null,
      verdicts.get(b.tweet_id) === "evolved" ? "story has likely developed since this was posted" : null,
    ].filter(Boolean),
  }));

  const res = await grok().chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: "system",
        content: `You write a personal weekly digest of the user's bookmarked X posts, in markdown.
Structure: start with "# Your Bookmark Brief" and the date range, then a 2-3 sentence overview,
then one "## <Topic>" section per topic group (group related topics; aim for 3-7 sections).
Within each section, synthesize the posts into flowing insight — don't just list them. Every post you
draw on must be cited inline as a markdown link on the author's name, e.g. [@handle](url).
Mention any caveats naturally. End with "## Worth a deeper look" — the 3 most substantive items.
${
  excluded.length > 0
    ? `After that, add "## Excluded as disputed" briefly listing ${excluded.length} post(s) omitted because Community Notes rated them misleading (links only, one line each).`
    : ""
}
Write for listening/reading pleasure: smart, warm, no filler.`,
      },
      {
        role: "user",
        content: JSON.stringify({
          dateRange,
          posts: payload,
          excluded: excluded.map((b) => ({
            url: `https://x.com/${b.author_handle ?? "i"}/status/${b.tweet_id}`,
            author: `@${b.author_handle}`,
          })),
        }),
      },
    ],
    temperature: 0.6,
  });
  return res.choices[0]?.message?.content ?? "";
}

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
    `You write a two-host podcast script from a digest of the listener's own X bookmarks.
Host A ("Alex") is curious and steers the show; Host B ("Blake") is the analyst who adds depth.
Style: NotebookLM-like — conversational, enthusiastic but not cheesy, builds on each other,
occasional brief reactions. Open by welcoming the listener to their weekly Bookmark Brief;
close with a quick recap. Attribute ideas to the original posters by handle when natural.
Total length: about ${wordBudget} words (${Math.min(targetMinutes, 30)} minutes at 150 wpm) — do not exceed it.
Respond with JSON: {"lines":[{"speaker":"A"|"B","line":"..."}]}`,
    markdown
  );
  return (result.lines ?? []).filter(
    (l) => (l.speaker === "A" || l.speaker === "B") && typeof l.line === "string" && l.line.trim()
  );
}
