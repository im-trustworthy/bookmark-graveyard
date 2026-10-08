"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { describeSync, formatRange } from "@/lib/dashboard-text";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import VoiceSettings from "./voice-settings";

// What the picker offers. There is no audio-only: the markdown is always written first and the
// podcast script is derived from it.
type Format = "markdown" | "both";

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
  // Briefs made before the picker dropped audio-only are still stored as "audio". Nothing below reads
  // this: the player and the download links key off audio_url / markdown_url.
  format: Format | "audio";
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

type TopicCount = { name: string; count: number };

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

export default function Dashboard({
  user,
  greeting = "Welcome back",
}: {
  user: { handle: string; display_name: string | null; avatar_url: string | null };
  greeting?: string;
}) {
  const [format, setFormat] = useState<Format>("both");
  const [from, setFrom] = useState(isoDaysAgo(7));
  const [to, setTo] = useState(isoDaysAgo(0));
  const [selectedTopics, setSelectedTopics] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [topicCounts, setTopicCounts] = useState<TopicCount[]>([]);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [totalBookmarks, setTotalBookmarks] = useState<number | null>(null);
  const [libraryCount, setLibraryCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncStage, setSyncStage] = useState<string | null>(null);
  const [syncProgress, setSyncProgress] = useState<{ done: number; total: number } | null>(null);
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
  const bgVideoRef = useRef<HTMLVideoElement | null>(null);
  const [bgOn, setBgOn] = useState(true);

  // Honor the saved background preference. Runs post-hydration, so it also
  // pauses the autoPlay that may have already kicked off.
  useEffect(() => {
    if (localStorage.getItem("bb_bg") === "off") {
      setBgOn(false);
      bgVideoRef.current?.pause();
    }
  }, []);

  function toggleBackground() {
    const next = !bgOn;
    setBgOn(next);
    localStorage.setItem("bb_bg", next ? "on" : "off");
    const video = bgVideoRef.current;
    if (!video) return;
    if (next) {
      // Called inside the click gesture, so playback starts immediately
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }

  const loadBookmarks = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ from, to });
    if (selectedTopics.length > 0) params.set("topics", selectedTopics.join(","));
    const res = await fetch(`/api/bookmarks?${params}`);
    let total = null;
    if (res.ok) {
      const body = await res.json();
      setBookmarks(body.bookmarks ?? []);
      setTopicCounts(body.topics ?? []);
      total = body.total ?? 0;
      setTotalBookmarks(total);
      setLibraryCount(body.library ?? total);
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
      setSyncProgress(null);
      const res = await fetch("/api/sync", { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Sync failed");
      await loadBookmarks();

      // Then ingest sources + analyze in short chunks; tags fill in as chunks land.
      let pending: number = body.pendingAnalysis ?? 0;
      const toAnalyze = pending;
      while (pending > 0) {
        setSyncStage("Reading linked articles & media, tagging topics…");
        setSyncProgress({ done: toAnalyze - pending, total: toAnalyze });
        const enrichRes = await fetch("/api/enrich", { method: "POST" });
        const enrichBody = await enrichRes.json();
        if (!enrichRes.ok) throw new Error(enrichBody.error ?? "Analysis failed");
        if (!enrichBody.enriched && !enrichBody.ingested && enrichBody.remaining > 0) {
          throw new Error(`Analysis stalled with ${enrichBody.remaining} bookmarks left — try again`);
        }
        pending = enrichBody.remaining;
        await loadBookmarks();
      }
      setSyncMessage(describeSync(body, from, to, toAnalyze));
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
      setSyncStage(null);
      setSyncProgress(null);
    }
  }, [loadBookmarks, from, to]);

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

  // Chips come strictly from the posts loaded for the current date range. A
  // selected topic that drops to zero (e.g. after narrowing the dates) stays
  // visible at 0 so it can still be unselected.
  const chips = useMemo<TopicCount[]>(() => {
    const present = new Set(topicCounts.map((t) => t.name));
    const stale = selectedTopics.filter((t) => !present.has(t)).map((name) => ({ name, count: 0 }));
    return [...topicCounts, ...stale];
  }, [topicCounts, selectedTopics]);

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
      { value: "both", label: "Markdown + Podcast" },
    ],
    []
  );

  return (
    <main className="relative min-h-screen text-zinc-100">
      {/* Background video — same treatment as the landing page: muted +
          playsInline for mobile autoplay, loops, restarts on refresh,
          object-cover for every viewport, hidden under prefers-reduced-motion
          (body's zinc-950 remains). Fixed so it holds through scrolling. */}
      <video
        ref={bgVideoRef}
        aria-hidden="true"
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        disablePictureInPicture
        className={`pointer-events-none fixed inset-0 -z-20 h-full w-full object-cover motion-reduce:hidden ${bgOn ? "" : "hidden"}`}
      >
        <source src="/main-page-bg.mp4" type="video/mp4" />
      </video>
      {/* Scrim: light enough to keep the scene visible — the glass panels
          add their own local darkening + blur where text needs contrast.
          With the background stopped it goes fully opaque black. */}
      <div
        aria-hidden="true"
        className={`pointer-events-none fixed inset-0 -z-10 ${bgOn ? "bg-zinc-950/65" : "bg-black"}`}
      />
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
              <h1 className="truncate font-heading text-2xl tracking-wide sm:text-3xl">
                {greeting}, @{user.handle}
              </h1>
              <p className="text-sm text-zinc-400">Let&apos;s revive your bookmarks.</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={toggleBackground}
              aria-pressed={bgOn}
              aria-label={bgOn ? "Stop background animation" : "Start background animation"}
              className="rounded-full border border-white/15 bg-white/5 px-4 py-2 text-sm backdrop-blur-md transition hover:border-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
            >
              {bgOn ? "Stop background" : "Start background"}
            </button>
            <button
              onClick={sync}
              disabled={syncing}
              aria-label={syncing ? "Checking X for new bookmarks" : "Check X for new bookmarks"}
              className="rounded-full border border-white/15 bg-white/5 px-4 py-2 text-sm backdrop-blur-md transition hover:border-white/30 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
            >
              {syncing ? "Checking X…" : "Check X for new"}
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
          {syncing && (
            <section
              role="status"
              aria-live="polite"
              className="space-y-3 rounded-2xl border border-sky-400/30 bg-sky-500/10 p-4 shadow-lg shadow-black/20 backdrop-blur-xl"
            >
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="flex items-center gap-2 font-medium text-sky-200">
                  <span className="inline-block h-3 w-3 shrink-0 rounded-full border-2 border-sky-300 border-t-transparent animate-spin" />
                  {syncStage ?? "Syncing your bookmarks…"}
                </span>
                {syncProgress && (
                  <span className="shrink-0 tabular-nums text-sky-300/80">
                    {syncProgress.done} of {syncProgress.total} analyzed
                  </span>
                )}
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-zinc-800/80">
                {syncProgress && syncProgress.total > 0 ? (
                  <div
                    className="h-full rounded-full bg-sky-400 transition-[width] duration-500"
                    style={{ width: `${Math.round((syncProgress.done / syncProgress.total) * 100)}%` }}
                  />
                ) : (
                  <div className="h-full w-1/3 rounded-full bg-sky-400/80 animate-[slide_1.4s_ease-in-out_infinite]" />
                )}
              </div>
              <p className="text-xs text-sky-200/70">
                {syncProgress
                  ? "Your bookmarks are already listed below. Topic tags and filters fill in as each batch finishes."
                  : "Pulling your latest bookmarks from X."}
              </p>
            </section>
          )}
          {syncMessage && <p className="text-sm text-emerald-400">{syncMessage}</p>}
          {errorMessage && <p className="text-sm text-red-400">{errorMessage}</p>}
        </div>

        {/* Resumable draft banner */}
        {resumable && !creating && (
          <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-400/25 bg-amber-500/10 p-4 backdrop-blur-xl">
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
          <h2 className="font-heading text-2xl tracking-wide text-zinc-100">
            How would you like your summary?
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
                    : "border-white/15 bg-white/5 backdrop-blur-md hover:border-white/30"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </section>

        {/* Filters */}
        <section className="space-y-4 rounded-2xl border border-white/10 bg-white/[0.06] p-5 shadow-lg shadow-black/20 backdrop-blur-xl">
          <h2 className="font-heading text-2xl tracking-wide text-zinc-100">Filters</h2>
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-3">
              <label className="text-sm text-zinc-400">
                Posted between{" "}
                <input
                  type="date"
                  aria-label="Posted on or after"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  className="ml-1 rounded-lg border border-white/15 bg-zinc-900/50 px-3 py-1.5 text-zinc-100 backdrop-blur-md [color-scheme:dark] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                />
              </label>
              <label className="text-sm text-zinc-400">
                and{" "}
                <input
                  type="date"
                  aria-label="Posted on or before"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  className="ml-1 rounded-lg border border-white/15 bg-zinc-900/50 px-3 py-1.5 text-zinc-100 backdrop-blur-md [color-scheme:dark] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                />
              </label>
            </div>
            <p className="text-xs text-zinc-500">
              Filters by when a post was published. X doesn&apos;t share when you saved a bookmark, and
              checking X always pulls your whole list, so these dates only change what&apos;s shown.
            </p>
          </div>
          {chips.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs text-zinc-500">Topics found in these posts</p>
              <div className="flex flex-wrap gap-2">
                {chips.map(({ name, count }) => {
                  const active = selectedTopics.includes(name);
                  return (
                    <button
                      key={name}
                      onClick={() => toggleTopic(name)}
                      aria-pressed={active}
                      className={`rounded-full border px-3 py-1 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 ${
                        active
                          ? "border-sky-500 bg-sky-500/20 text-sky-300"
                          : "border-white/15 bg-white/5 text-zinc-300 backdrop-blur-md hover:border-white/30"
                      }`}
                    >
                      {name}
                      <span className={`ml-1.5 tabular-nums ${active ? "text-sky-400/80" : "text-zinc-500"}`}>
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <p className="text-xs text-zinc-600">
              {syncing
                ? "Topics fill in here as each batch is analyzed…"
                : loading
                  ? "Loading topics…"
                  : bookmarks.length === 0
                    ? "No posts in this date range, so no topics to show. Widen the dates to see more."
                    : "No topics yet for these posts — use Check X for new to analyze them."}
            </p>
          )}
        </section>

        {/* Voices */}
        <VoiceSettings />

        {/* Create button */}
        <div className="space-y-3">
          <button
            onClick={createBrief}
            disabled={creating || (selected.size === 0 && bookmarks.length === 0)}
            className="relative w-full overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-b from-zinc-800 via-zinc-950 to-black py-4 font-heading text-xl tracking-wide text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.28),inset_0_-3px_8px_rgba(0,0,0,0.9),0_10px_30px_rgba(0,0,0,0.55)] transition before:pointer-events-none before:absolute before:inset-x-3 before:top-1 before:h-[45%] before:rounded-t-xl before:bg-gradient-to-b before:from-white/15 before:to-transparent hover:from-zinc-700 active:translate-y-px active:from-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:cursor-not-allowed disabled:border-white/5 disabled:bg-none disabled:bg-zinc-900 disabled:text-zinc-600 disabled:shadow-none disabled:before:hidden"
          >
            {creating
              ? "Creating your brief…"
              : selected.size > 0
                ? `Create my brief (${selected.size} selected)`
                : `Create my brief (all ${bookmarks.length} shown)`}
          </button>
          {creating && (
            <div className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.06] p-4 shadow-lg shadow-black/20 backdrop-blur-xl">
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
          <section className="space-y-4 rounded-2xl border border-emerald-400/25 bg-emerald-500/10 p-5 backdrop-blur-xl">
            <h2 className="font-heading text-2xl tracking-wide">{result.episode.title}</h2>
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
                  className="rounded-full border border-white/15 bg-white/5 px-4 py-2 text-sm backdrop-blur-md transition hover:border-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
                >
                  Download .md
                </a>
              )}
              {result.episode.audio_url && (
                <a
                  href={result.episode.audio_url}
                  download="bookmark-brief.mp3"
                  className="rounded-full border border-white/15 bg-white/5 px-4 py-2 text-sm backdrop-blur-md transition hover:border-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
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
                <div className="mt-3 max-h-96 overflow-y-auto rounded-xl border border-white/10 bg-zinc-950/40 p-4 backdrop-blur-md">
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
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 className="font-heading text-2xl tracking-wide text-zinc-100">Your bookmarks</h2>
            <span className="text-xs text-zinc-600">
              Click to hand-pick posts · × removes for good
            </span>
          </div>
          <p className="text-sm text-zinc-400" aria-live="polite">
            {libraryCount === null
              ? "Loading…"
              : `Showing ${bookmarks.length} of ${libraryCount} posted ${formatRange(from, to)}`}
            {libraryCount !== null && selectedTopics.length > 0 && (
              <span className="text-zinc-500">
                {" · filtered to "}
                {selectedTopics.length === 1 ? selectedTopics[0] : `${selectedTopics.length} topics`}
              </span>
            )}
          </p>
          {loading && bookmarks.length === 0 && (
            <ul className="space-y-3" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <li key={i} className="animate-pulse space-y-2 rounded-xl border border-white/10 bg-white/[0.04] p-4">
                  <div className="h-3 w-1/3 rounded bg-white/10" />
                  <div className="h-3 w-full rounded bg-white/10" />
                  <div className="h-3 w-2/3 rounded bg-white/10" />
                </li>
              ))}
            </ul>
          )}
          {!loading && bookmarks.length === 0 && (
            <p className="text-sm text-zinc-500">
              {syncing
                ? "Pulling your bookmarks from X — they'll appear here in a few seconds…"
                : "Nothing posted in this range — widen the dates, or check X for new bookmarks."}
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
                  className={`cursor-pointer space-y-2 rounded-xl border p-4 backdrop-blur-md transition ${
                    isSelected
                      ? "border-sky-400/60 bg-sky-400/15"
                      : "border-white/10 bg-white/[0.04] hover:border-white/25"
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
                    {!a && (
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-sky-400/40 px-2 py-0.5 text-[11px] text-sky-300/80">
                        {syncing && (
                          <span className="inline-block h-1.5 w-1.5 rounded-full bg-sky-400 animate-pulse" />
                        )}
                        {syncing ? "Analyzing…" : "Not analyzed yet"}
                      </span>
                    )}
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
            <h2 className="font-heading text-2xl tracking-wide text-zinc-100">
              Previous briefs
            </h2>
            <ul className="space-y-3">
              {episodes.map((ep) => (
                <li key={ep.id} className="space-y-3 rounded-xl border border-white/10 bg-white/[0.04] p-4 backdrop-blur-md">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="font-heading text-lg tracking-wide text-zinc-100">{ep.title}</span>
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
