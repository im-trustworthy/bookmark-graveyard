"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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

type ResumableStage = "needs_script" | "rendering" | "needs_finalize";

interface ResumableDraft {
  episodeId: string;
  stage: ResumableStage;
  totalLines: number;
  nextCursor: number;
  title?: string;
  createdAt?: string;
}

interface DigestStatusResponse {
  episodeId: string | null;
  stage: ResumableStage | "ready" | "none";
  totalLines: number;
  nextCursor: number;
  markdownReady: boolean;
  title?: string;
  createdAt?: string;
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
  const [createProgress, setCreateProgress] = useState<number | null>(null); // 0..1, null = indeterminate
  const [createStartedAt, setCreateStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [result, setResult] = useState<{
    episode: Episode;
    markdown?: string;
    stats?: { considered: number; droppedAsStale: number; excludedAsMisleading: number };
  } | null>(null);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [resumable, setResumable] = useState<ResumableDraft | null>(null);
  const [discarding, setDiscarding] = useState(false);

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

  // Checks for an interrupted brief generation (refresh, network blip, TTS
  // hiccup) so it can be offered back as "Resume" instead of silently lost.
  const checkResumable = useCallback(async () => {
    try {
      const res = await fetch("/api/digest/status");
      if (!res.ok) return;
      const body = (await res.json()) as DigestStatusResponse;
      if (body.episodeId && (body.stage === "needs_script" || body.stage === "rendering" || body.stage === "needs_finalize")) {
        setResumable({
          episodeId: body.episodeId,
          stage: body.stage,
          totalLines: body.totalLines,
          nextCursor: body.nextCursor,
          title: body.title,
          createdAt: body.createdAt,
        });
      } else {
        setResumable(null);
      }
    } catch {
      // Best-effort: the resume banner is a convenience, not the critical path.
    }
  }, []);

  useEffect(() => {
    loadBookmarks();
  }, [loadBookmarks]);

  useEffect(() => {
    loadEpisodes();
  }, [loadEpisodes]);

  useEffect(() => {
    checkResumable();
  }, [checkResumable]);

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

      // Then ingest sources + analyze in short chunks; tags fill in as chunks land.
      let pending: number = body.pendingAnalysis ?? 0;
      const toAnalyze = pending;
      while (pending > 0) {
        setSyncStage(
          `Reading linked articles & media, analyzing topics… ${toAnalyze - pending} of ${toAnalyze} done`
        );
        const enrichRes = await fetch("/api/enrich", { method: "POST" });
        const enrichBody = await enrichRes.json();
        if (!enrichRes.ok) throw new Error(enrichBody.error ?? "Analysis failed");
        if (!enrichBody.enriched && !enrichBody.ingested && enrichBody.remaining > 0) {
          throw new Error(`Analysis stalled with ${enrichBody.remaining} bookmarks left — try again`);
        }
        pending = enrichBody.remaining;
        await loadBookmarks();
      }
      setSyncMessage(
        `Synced ${body.fetched} bookmarks (${body.new} new${toAnalyze ? `, ${toAnalyze} analyzed with sources` : ""}).`
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

  // Ticking clock while a brief is being created, so it never looks frozen
  useEffect(() => {
    if (!createStartedAt) return;
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - createStartedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [createStartedAt]);

  async function post(url: string, payload: Record<string, unknown>) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `${url} failed`);
    return body;
  }

  // Stages 2-4 (script -> render loop -> finalize), shared by a fresh
  // generation and a resumed one. `cursor`/`skipScript` let a resume jump in
  // partway: skipScript reuses an already-written script, and the render
  // loop's own `while (cursor < totalLines)` guard means a cursor that's
  // already at totalLines (the needs_finalize case) just falls through
  // straight to finalize with no branching required.
  async function runAudioStages(
    episodeId: string,
    opts: { skipScript?: boolean; totalLines?: number; cursor?: number } = {}
  ) {
    let totalLines = opts.totalLines ?? 0;
    if (!opts.skipScript) {
      setCreateStage("Writing the show script…");
      setCreateProgress(null);
      const scripted = await post("/api/digest/script", { episodeId, targetMinutes: 20 });
      totalLines = scripted.totalLines;
    }

    let cursor = opts.cursor ?? 0;
    setCreateProgress(totalLines > 0 ? Math.min(cursor / totalLines, 1) : 0);
    while (cursor < totalLines) {
      setCreateStage(`Recording audio — line ${cursor + 1} of ${totalLines}`);
      const rendered = await post("/api/digest/render", { episodeId, cursor });
      cursor = rendered.nextCursor;
      setCreateProgress(Math.min(cursor / totalLines, 1));
      if (rendered.done) break;
    }

    setCreateStage("Mixing & publishing…");
    setCreateProgress(null);
    return post("/api/digest/finalize", { episodeId });
  }

  // On any stage failure the draft row is left in place on purpose (nothing
  // here deletes it) so it's resumable — the error message says so whenever
  // we got far enough to have a draft, and refreshes the banner immediately.
  function reportCreateError(err: unknown, episodeId: string | undefined) {
    const base = err instanceof Error ? err.message : "Generation failed";
    setErrorMessage(
      episodeId
        ? `${base} — this brief is saved as a draft, so you can resume it instead of starting over.`
        : base
    );
    if (episodeId) checkResumable();
  }

  async function createBrief() {
    setCreating(true);
    setErrorMessage(null);
    setResult(null);
    setCreateStartedAt(Date.now());
    setElapsed(0);
    let episodeId: string | undefined;
    try {
      // Stage 1: analyze, check freshness, outline, write the markdown brief
      setCreateStage("Reading your posts & writing the brief…");
      setCreateProgress(null);
      const prepared = await post("/api/digest/prepare", {
        format,
        from,
        to,
        topics: selectedTopics,
        // Hand-picked posts take precedence over date/topic filters
        tweetIds: selected.size > 0 ? [...selected] : undefined,
        targetMinutes: 20,
      });
      if (prepared.done) {
        setResult(prepared);
        await loadEpisodes();
        return;
      }
      episodeId = prepared.episode.id as string;
      setResumable(null); // starting fresh supersedes any stale resumable draft

      const finalized = await runAudioStages(episodeId);
      setResult({ episode: finalized.episode, markdown: prepared.markdown, stats: prepared.stats });
      await loadEpisodes();
    } catch (err) {
      reportCreateError(err, episodeId);
    } finally {
      setCreating(false);
      setCreateStage(null);
      setCreateProgress(null);
      setCreateStartedAt(null);
    }
  }

  async function resumeBrief() {
    if (!resumable) return;
    const { episodeId, stage, totalLines, nextCursor } = resumable;
    setCreating(true);
    setErrorMessage(null);
    setResult(null);
    setCreateStartedAt(Date.now());
    setElapsed(0);
    try {
      const finalized = await runAudioStages(episodeId, {
        skipScript: stage !== "needs_script",
        totalLines,
        cursor: nextCursor,
      });
      setResult({ episode: finalized.episode });
      setResumable(null);
      await loadEpisodes();
    } catch (err) {
      reportCreateError(err, episodeId);
    } finally {
      setCreating(false);
      setCreateStage(null);
      setCreateProgress(null);
      setCreateStartedAt(null);
    }
  }

  async function discardResumable() {
    if (!resumable) return;
    setDiscarding(true);
    try {
      const res = await fetch(`/api/digest/status?episodeId=${resumable.episodeId}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Couldn't discard draft");
      }
      setResumable(null);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Couldn't discard draft");
    } finally {
      setDiscarding(false);
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
        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            {user.avatar_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={user.avatar_url}
                alt=""
                className="h-10 w-10 shrink-0 rounded-full ring-1 ring-zinc-800"
              />
            )}
            <div className="min-w-0">
              <h1 className="truncate text-xl font-semibold tracking-tight">
                Welcome back, @{user.handle}
              </h1>
              <p className="text-sm text-zinc-400">Let&apos;s create your summary.</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={sync}
              disabled={syncing}
              aria-label={syncing ? "Syncing bookmarks" : "Sync bookmarks"}
              className="rounded-full border border-zinc-700 px-4 py-2 text-sm transition hover:border-zinc-500 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
            >
              {syncing ? "Syncing…" : "Re-sync"}
            </button>
            <form action="/api/auth/logout" method="post">
              <button
                aria-label="Log out"
                className="rounded-full px-4 py-2 text-sm text-zinc-500 transition hover:text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
              >
                Log out
              </button>
            </form>
          </div>
        </header>

        <div className="space-y-2">
          {syncStage && (
            <p className="flex items-center gap-2 text-sm text-sky-400">
              <span className="inline-block h-3 w-3 rounded-full border-2 border-sky-400 border-t-transparent animate-spin" />
              {syncStage}
            </p>
          )}
          {syncMessage && <p className="text-sm text-emerald-400">{syncMessage}</p>}
          {errorMessage && <p className="text-sm text-red-400">{errorMessage}</p>}
        </div>

        {/* Resumable draft banner */}
        {resumable && !creating && (
          <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-800/60 bg-amber-950/20 p-4">
            <p className="text-sm text-amber-200">
              A brief from{" "}
              {resumable.createdAt
                ? new Date(resumable.createdAt).toLocaleDateString("en-US", { month: "long", day: "numeric" })
                : "earlier"}{" "}
              stopped partway.
            </p>
            <div className="flex shrink-0 items-center gap-2">
              <button
                onClick={resumeBrief}
                className="rounded-full bg-amber-500 px-4 py-1.5 text-sm font-medium text-zinc-950 transition hover:bg-amber-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
              >
                Resume
              </button>
              <button
                onClick={discardResumable}
                disabled={discarding}
                className="rounded-full border border-amber-800/60 px-4 py-1.5 text-sm text-amber-200 transition hover:border-amber-600 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
              >
                {discarding ? "Discarding…" : "Discard"}
              </button>
            </div>
          </section>
        )}

        {/* Format picker */}
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wide">
            How would you like it?
          </h2>
          <div className="flex flex-wrap gap-2">
            {formatOptions.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setFormat(opt.value)}
                aria-pressed={format === opt.value}
                className={`rounded-full border px-4 py-2 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 ${
                  format === opt.value
                    ? "border-zinc-100 bg-zinc-100 font-medium text-zinc-950"
                    : "border-zinc-700 hover:border-zinc-500"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </section>

        {/* Filters */}
        <section className="space-y-4 rounded-2xl border border-zinc-800 p-5">
          <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wide">Filters</h2>
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-sm text-zinc-400">
              From{" "}
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="ml-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-zinc-100 [color-scheme:dark] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
              />
            </label>
            <label className="text-sm text-zinc-400">
              To{" "}
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="ml-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-zinc-100 [color-scheme:dark] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
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
                  aria-pressed={selectedTopics.includes(topic)}
                  className={`rounded-full border px-3 py-1 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 ${
                    selectedTopics.includes(topic)
                      ? "border-sky-500 bg-sky-500/20 text-sky-300"
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
        <div className="space-y-3">
          <button
            onClick={createBrief}
            disabled={creating || (selected.size === 0 && bookmarks.length === 0)}
            className="w-full rounded-2xl bg-sky-500 py-4 text-lg font-semibold text-white transition hover:bg-sky-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500 disabled:hover:bg-zinc-800"
          >
            {creating
              ? "Creating your brief…"
              : selected.size > 0
                ? `Create my brief (${selected.size} selected)`
                : `Create my brief (all ${bookmarks.length} shown)`}
          </button>
          {creating && (
            <div className="space-y-3 rounded-2xl border border-zinc-800 p-4">
              <div className="flex items-center justify-between text-sm">
                <span className="text-zinc-300">{createStage}</span>
                <span className="tabular-nums text-zinc-600">
                  {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
                {createProgress === null ? (
                  <div className="h-full w-1/3 rounded-full bg-sky-500/80 animate-[slide_1.4s_ease-in-out_infinite]" />
                ) : (
                  <div
                    className="h-full rounded-full bg-sky-500 transition-[width] duration-500"
                    style={{ width: `${Math.round(createProgress * 100)}%` }}
                  />
                )}
              </div>
              {createProgress !== null && (
                <p className="text-right text-xs tabular-nums text-zinc-600">
                  {Math.round(createProgress * 100)}%
                </p>
              )}
            </div>
          )}
          {selected.size > 0 && !creating && (
            <p className="text-center text-xs text-zinc-500">
              Using only your hand-picked posts.{" "}
              <button
                onClick={() => setSelected(new Set())}
                className="rounded text-sky-400 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
              >
                Clear selection
              </button>
            </p>
          )}
        </div>

        {/* Result */}
        {result && (
          <section className="space-y-4 rounded-2xl border border-emerald-800/60 bg-emerald-950/20 p-5">
            <h2 className="font-semibold">{result.episode.title}</h2>
            {result.stats && (
              <p className="text-sm text-zinc-400">
                {result.stats.considered} bookmarks considered
                {result.stats.droppedAsStale > 0 && `, ${result.stats.droppedAsStale} dropped as stale`}
                {result.stats.excludedAsMisleading > 0 &&
                  `, ${result.stats.excludedAsMisleading} excluded per Community Notes`}
                .
              </p>
            )}
            {result.episode.audio_url && (
              <audio
                controls
                src={result.episode.audio_url}
                aria-label={`Audio for ${result.episode.title}`}
                className="w-full"
              />
            )}
            <div className="flex flex-wrap gap-3">
              {result.episode.markdown_url && (
                <a
                  href={result.episode.markdown_url}
                  download="bookmark-brief.md"
                  className="rounded-full border border-zinc-700 px-4 py-2 text-sm transition hover:border-zinc-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
                >
                  Download .md
                </a>
              )}
              {result.episode.audio_url && (
                <a
                  href={result.episode.audio_url}
                  download="bookmark-brief.mp3"
                  className="rounded-full border border-zinc-700 px-4 py-2 text-sm transition hover:border-zinc-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
                >
                  Download .mp3
                </a>
              )}
            </div>
            {result.markdown && (
              <details className="group">
                <summary className="cursor-pointer rounded text-sm text-zinc-400 transition hover:text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500">
                  Preview markdown
                </summary>
                <div className="mt-3 max-h-96 overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                  <div className="prose prose-invert prose-sm max-w-none prose-headings:text-zinc-100 prose-strong:text-zinc-100 prose-code:text-zinc-200 prose-a:text-sky-400 prose-a:no-underline hover:prose-a:underline">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{result.markdown}</ReactMarkdown>
                  </div>
                </div>
              </details>
            )}
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
                  className={`cursor-pointer space-y-2 rounded-xl border p-4 transition ${
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
                      className="min-w-0 truncate rounded text-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                    >
                      {b.author_name ?? "Unknown"}{" "}
                      <span className="text-zinc-500">@{b.author_handle}</span>
                    </a>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="text-xs text-zinc-600">
                        {b.tweet_created_at?.slice(0, 10)}
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          hideBookmark(b.tweet_id);
                        }}
                        title="Remove from list and future briefs"
                        aria-label={`Remove bookmark from ${b.author_name ?? "Unknown"}`}
                        className="flex h-5 w-5 items-center justify-center rounded-full text-sm leading-none text-zinc-600 transition hover:bg-red-950/50 hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
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
                        className="rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-400"
                      >
                        {t}
                      </span>
                    ))}
                    {a?.credibility === "misleading" && (
                      <span className="rounded-full bg-red-900/50 px-2 py-0.5 text-[11px] text-red-300">
                        ⚠ Community Noted
                      </span>
                    )}
                    {a?.credibility === "disputed" && (
                      <span className="rounded-full bg-amber-900/50 px-2 py-0.5 text-[11px] text-amber-300">
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
                <li key={ep.id} className="space-y-3 rounded-xl border border-zinc-800 p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="text-sm font-medium text-zinc-100">{ep.title}</span>
                    <span className="text-xs text-zinc-600">
                      {new Date(ep.created_at).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}
                      {" · "}
                      {ep.bookmark_count ?? "?"} posts
                      {ep.duration_seconds ? ` · ${Math.round(ep.duration_seconds / 60)} min` : ""}
                    </span>
                  </div>
                  {ep.audio_url && (
                    <audio
                      controls
                      src={ep.audio_url}
                      aria-label={`Audio for ${ep.title}`}
                      className="w-full"
                    />
                  )}
                  {ep.markdown_url && (
                    <a
                      href={ep.markdown_url}
                      download
                      className="inline-block w-fit rounded text-xs text-zinc-500 transition hover:text-sky-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
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
