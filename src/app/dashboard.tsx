"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Format = "markdown" | "audio" | "both";

interface Analysis {
  topics: string[];
  summary: string | null;
  content_type: string;
  credibility: string;
}

interface Bookmark {
  tweet_id: string;
  author_handle: string | null;
  author_name: string | null;
  text: string;
  tweet_created_at: string | null;
  first_seen_at: string;
  bookmark_analysis: Analysis | Analysis[] | null;
}

interface Episode {
  id: string;
  title: string;
  format: Format;
  duration_seconds: number | null;
  bookmark_count: number | null;
  created_at: string;
  markdown_url: string | null;
  audio_url: string | null;
}

function analysisOf(b: Bookmark): Analysis | null {
  if (!b.bookmark_analysis) return null;
  return Array.isArray(b.bookmark_analysis) ? (b.bookmark_analysis[0] ?? null) : b.bookmark_analysis;
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

export default function Dashboard({
  user,
}: {
  user: { handle: string; display_name: string | null; avatar_url: string | null };
}) {
  const [format, setFormat] = useState<Format>("both");
  const [from, setFrom] = useState(isoDaysAgo(7));
  const [to, setTo] = useState(isoDaysAgo(0));
  const [selectedTopics, setSelectedTopics] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allTopics, setAllTopics] = useState<string[]>([]);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [totalBookmarks, setTotalBookmarks] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncStage, setSyncStage] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createStage, setCreateStage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [result, setResult] = useState<{ episode: Episode; markdown: string; stats: { considered: number; droppedAsStale: number; excludedAsMisleading: number } } | null>(null);
  const [episodes, setEpisodes] = useState<Episode[]>([]);

  const loadBookmarks = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ from, to });
    if (selectedTopics.length > 0) params.set("topics", selectedTopics.join(","));
    const res = await fetch(`/api/bookmarks?${params}`);
    let total = null;
    if (res.ok) {
      const body = await res.json();
      setBookmarks(body.bookmarks ?? []);
      setAllTopics(body.allTopics ?? []);
      total = body.total ?? 0;
      setTotalBookmarks(total);
    }
    setLoading(false);
    return total;
  }, [from, to, selectedTopics]);

  const loadEpisodes = useCallback(async () => {
    const res = await fetch("/api/episodes");
    if (res.ok) setEpisodes((await res.json()).episodes ?? []);
  }, []);

  useEffect(() => {
    loadBookmarks();
  }, [loadBookmarks]);

  useEffect(() => {
    loadEpisodes();
  }, [loadEpisodes]);

  const sync = useCallback(async () => {
    setSyncing(true);
    setSyncMessage(null);
    setErrorMessage(null);
    try {
      // Fast: fetch from X + store. Bookmarks appear immediately.
      setSyncStage("Pulling bookmarks from X…");
      const res = await fetch("/api/sync", { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Sync failed");
      await loadBookmarks();

      // Then analyze in short chunks; topic tags fill in as each chunk lands.
      let pending: number = body.pendingAnalysis ?? 0;
      const toAnalyze = pending;
      while (pending > 0) {
        setSyncStage(`Analyzing topics… ${toAnalyze - pending} of ${toAnalyze} done`);
        const enrichRes = await fetch("/api/enrich", { method: "POST" });
        const enrichBody = await enrichRes.json();
        if (!enrichRes.ok) throw new Error(enrichBody.error ?? "Analysis failed");
        if (!enrichBody.enriched && enrichBody.remaining > 0) {
          throw new Error(`Analysis stalled with ${enrichBody.remaining} bookmarks left — try again`);
        }
        pending = enrichBody.remaining;
        await loadBookmarks();
      }
      setSyncMessage(
        `Synced ${body.fetched} bookmarks (${body.new} new${toAnalyze ? `, ${toAnalyze} analyzed` : ""}).`
      );
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
      setSyncStage(null);
    }
  }, [loadBookmarks]);

  // First visit: pull bookmarks automatically instead of waiting for a click.
  useEffect(() => {
    if (totalBookmarks === 0 && !syncing) sync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalBookmarks]);

  async function createBrief() {
    setCreating(true);
    setErrorMessage(null);
    setResult(null);
    setCreateStage(
      format === "markdown" ? "Analyzing & writing your brief…" : "Analyzing, writing & recording… (audio takes a few minutes)"
    );
    try {
      const res = await fetch("/api/digest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          format,
          from,
          to,
          topics: selectedTopics,
          // Hand-picked posts take precedence over date/topic filters
          tweetIds: selected.size > 0 ? [...selected] : undefined,
          targetMinutes: 20,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Generation failed");
      setResult(body);
      await loadEpisodes();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setCreating(false);
      setCreateStage(null);
    }
  }

  const toggleTopic = (topic: string) =>
    setSelectedTopics((prev) =>
      prev.includes(topic) ? prev.filter((t) => t !== topic) : [...prev, topic]
    );

  const toggleSelected = (tweetId: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(tweetId)) next.delete(tweetId);
      else next.add(tweetId);
      return next;
    });

  async function hideBookmark(tweetId: string) {
    // Optimistic: drop from the list immediately, persist in the background.
    setBookmarks((prev) => prev.filter((b) => b.tweet_id !== tweetId));
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(tweetId);
      return next;
    });
    const res = await fetch("/api/bookmarks/hide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tweet_id: tweetId }),
    });
    if (!res.ok) {
      setErrorMessage("Couldn't remove that bookmark — it may reappear on reload.");
      await loadBookmarks();
    }
  }

  const formatOptions: { value: Format; label: string }[] = useMemo(
    () => [
      { value: "markdown", label: "Markdown" },
      { value: "audio", label: "Audio" },
      { value: "both", label: "Markdown + Audio" },
    ],
    []
  );

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="max-w-3xl mx-auto px-6 py-10 space-y-8">
        {/* Header */}
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {user.avatar_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={user.avatar_url} alt="" className="w-10 h-10 rounded-full" />
            )}
            <div>
              <h1 className="text-xl font-semibold tracking-tight">
                Welcome back, @{user.handle}
              </h1>
              <p className="text-sm text-zinc-400">Let&apos;s create your summary.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={sync}
              disabled={syncing}
              className="text-sm px-4 py-2 rounded-full border border-zinc-700 hover:border-zinc-500 disabled:opacity-50 transition"
            >
              {syncing ? "Syncing…" : "Re-sync"}
            </button>
            <form action="/api/auth/logout" method="post">
              <button className="text-sm px-4 py-2 rounded-full text-zinc-500 hover:text-zinc-300 transition">
                Log out
              </button>
            </form>
          </div>
        </header>

        {syncStage && (
          <p className="text-sm text-sky-400 flex items-center gap-2">
            <span className="inline-block w-3 h-3 rounded-full border-2 border-sky-400 border-t-transparent animate-spin" />
            {syncStage}
          </p>
        )}
        {syncMessage && <p className="text-sm text-emerald-400">{syncMessage}</p>}
        {errorMessage && <p className="text-sm text-red-400">{errorMessage}</p>}

        {/* Format picker */}
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wide">
            How would you like it?
          </h2>
          <div className="flex gap-2">
            {formatOptions.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setFormat(opt.value)}
                className={`px-4 py-2 rounded-full text-sm border transition ${
                  format === opt.value
                    ? "bg-zinc-100 text-zinc-950 border-zinc-100 font-medium"
                    : "border-zinc-700 hover:border-zinc-500"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </section>

        {/* Filters */}
        <section className="rounded-2xl border border-zinc-800 p-5 space-y-4">
          <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wide">Filters</h2>
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-sm text-zinc-400">
              From{" "}
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="ml-1 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-1.5 text-zinc-100 [color-scheme:dark]"
              />
            </label>
            <label className="text-sm text-zinc-400">
              To{" "}
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="ml-1 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-1.5 text-zinc-100 [color-scheme:dark]"
              />
            </label>
            <span className="text-xs text-zinc-600">Filters by the post&apos;s date.</span>
          </div>
          {allTopics.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {allTopics.map((topic) => (
                <button
                  key={topic}
                  onClick={() => toggleTopic(topic)}
                  className={`px-3 py-1 rounded-full text-xs border transition ${
                    selectedTopics.includes(topic)
                      ? "bg-sky-500/20 border-sky-500 text-sky-300"
                      : "border-zinc-700 text-zinc-400 hover:border-zinc-500"
                  }`}
                >
                  {topic}
                </button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-zinc-600">
              Topic tags appear here after your first sync &amp; analysis.
            </p>
          )}
        </section>

        {/* Create button */}
        <button
          onClick={createBrief}
          disabled={creating || (selected.size === 0 && bookmarks.length === 0)}
          className="w-full py-4 rounded-2xl bg-sky-500 hover:bg-sky-400 disabled:opacity-40 disabled:hover:bg-sky-500 text-white font-semibold text-lg transition"
        >
          {creating
            ? createStage
            : selected.size > 0
              ? `Create my brief (${selected.size} selected)`
              : `Create my brief (all ${bookmarks.length} shown)`}
        </button>
        {selected.size > 0 && !creating && (
          <p className="text-xs text-zinc-500 -mt-4 text-center">
            Using only your hand-picked posts.{" "}
            <button onClick={() => setSelected(new Set())} className="text-sky-400 hover:underline">
              Clear selection
            </button>
          </p>
        )}

        {/* Result */}
        {result && (
          <section className="rounded-2xl border border-emerald-800/60 bg-emerald-950/20 p-5 space-y-4">
            <h2 className="font-semibold">{result.episode.title}</h2>
            <p className="text-sm text-zinc-400">
              {result.stats.considered} bookmarks considered
              {result.stats.droppedAsStale > 0 && `, ${result.stats.droppedAsStale} dropped as stale`}
              {result.stats.excludedAsMisleading > 0 &&
                `, ${result.stats.excludedAsMisleading} excluded per Community Notes`}
              .
            </p>
            {result.episode.audio_url && (
              <audio controls src={result.episode.audio_url} className="w-full" />
            )}
            <div className="flex gap-3">
              {result.episode.markdown_url && (
                <a
                  href={result.episode.markdown_url}
                  download="bookmark-brief.md"
                  className="text-sm px-4 py-2 rounded-full border border-zinc-700 hover:border-zinc-500 transition"
                >
                  Download .md
                </a>
              )}
              {result.episode.audio_url && (
                <a
                  href={result.episode.audio_url}
                  download="bookmark-brief.mp3"
                  className="text-sm px-4 py-2 rounded-full border border-zinc-700 hover:border-zinc-500 transition"
                >
                  Download .mp3
                </a>
              )}
            </div>
            <details>
              <summary className="text-sm text-zinc-400 cursor-pointer">Preview markdown</summary>
              <pre className="mt-3 text-xs text-zinc-300 whitespace-pre-wrap max-h-96 overflow-y-auto">
                {result.markdown}
              </pre>
            </details>
          </section>
        )}

        {/* Bookmark list */}
        <section className="space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wide">
              Your bookmarks {loading ? "…" : `(${bookmarks.length})`}
            </h2>
            <span className="text-xs text-zinc-600">
              Click to hand-pick posts · × removes for good
            </span>
          </div>
          {!loading && bookmarks.length === 0 && (
            <p className="text-sm text-zinc-500">
              {syncing
                ? "Pulling your bookmarks from X — they'll appear here in a few seconds…"
                : "Nothing in this range — widen the dates or hit Re-sync."}
            </p>
          )}
          <ul className="space-y-3">
            {bookmarks.map((b) => {
              const a = analysisOf(b);
              const isSelected = selected.has(b.tweet_id);
              return (
                <li
                  key={b.tweet_id}
                  onClick={() => toggleSelected(b.tweet_id)}
                  className={`rounded-xl border p-4 space-y-2 cursor-pointer transition ${
                    isSelected
                      ? "border-sky-500 bg-sky-500/10"
                      : "border-zinc-800 hover:border-zinc-600"
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <a
                      href={`https://x.com/${b.author_handle ?? "i"}/status/${b.tweet_id}`}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="text-sm font-medium hover:underline"
                    >
                      {b.author_name ?? "Unknown"}{" "}
                      <span className="text-zinc-500">@{b.author_handle}</span>
                    </a>
                    <span className="flex items-center gap-2 shrink-0">
                      <span className="text-xs text-zinc-600">
                        {b.tweet_created_at?.slice(0, 10)}
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          hideBookmark(b.tweet_id);
                        }}
                        title="Remove from list and future briefs"
                        aria-label="Remove bookmark"
                        className="w-5 h-5 flex items-center justify-center rounded-full text-zinc-600 hover:text-red-400 hover:bg-red-950/50 transition text-sm leading-none"
                      >
                        ×
                      </button>
                    </span>
                  </div>
                  <p className="text-sm text-zinc-300 line-clamp-3">{b.text}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {(a?.topics ?? []).map((t) => (
                      <span
                        key={t}
                        className="text-[11px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400"
                      >
                        {t}
                      </span>
                    ))}
                    {a?.credibility === "misleading" && (
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-red-900/50 text-red-300">
                        ⚠ Community Noted
                      </span>
                    )}
                    {a?.credibility === "disputed" && (
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-900/50 text-amber-300">
                        note pending
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        {/* Episode history */}
        {episodes.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wide">
              Previous briefs
            </h2>
            <ul className="space-y-3">
              {episodes.map((ep) => (
                <li
                  key={ep.id}
                  className="rounded-xl border border-zinc-800 p-4 flex flex-col gap-2"
                >
                  <div className="flex items-baseline justify-between">
                    <span className="text-sm font-medium">{ep.title}</span>
                    <span className="text-xs text-zinc-600">
                      {ep.bookmark_count ?? "?"} posts
                      {ep.duration_seconds ? ` · ${Math.round(ep.duration_seconds / 60)} min` : ""}
                    </span>
                  </div>
                  {ep.audio_url && <audio controls src={ep.audio_url} className="w-full h-10" />}
                  {ep.markdown_url && (
                    <a
                      href={ep.markdown_url}
                      download
                      className="text-xs text-sky-400 hover:underline w-fit"
                    >
                      Download markdown
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}
