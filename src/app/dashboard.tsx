"use client";

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { describeAnalysisFailed, describeSync, formatRange, retryOutcome } from "@/lib/dashboard-text";
import { readBackgroundOn, writeBackgroundOn } from "@/lib/state/ui/background-pref";
import {
  BANNER_NONE,
  BRIEF_IDLE,
  DRAFT_GONE_MESSAGE,
  bannerControls,
  briefErrorMessage,
  briefFailureMessage,
  briefFlowReducer,
  briefProgress,
  briefStageLabel,
  draftFromStatus,
  resumeBannerReducer,
  resumeStartStage,
  type BriefStage,
  type DigestStatusResponse,
} from "@/lib/state/ui/brief-flow";
import {
  TARGET_MINUTES,
  resumeDraft,
  runAudioStages,
  type ResumeOutcome,
} from "@/lib/state/ui/brief-runner";
import {
  FREE_UP_IDLE,
  freeUpBusy as isFreeUpBusy,
  freeUpLabel as freeUpButtonLabel,
  freeUpMessage,
  freeUpReducer,
} from "@/lib/state/ui/free-up";
import {
  LIST_LOAD_FAILED_MESSAGE,
  HIDE_FAILED_MESSAGE,
  initialListLoad,
  listAnalysisFailed,
  listBookmarks,
  listLibraryCount,
  listLoadReducer,
  listTopics,
  type ListData,
  type TopicCount,
} from "@/lib/state/ui/list-load";
import {
  SYNC_IDLE,
  syncBusy,
  syncDoneMessage,
  syncErrorMessage,
  syncProgress as syncProgressOf,
  syncReducer,
  syncStageLabel,
} from "@/lib/state/ui/sync-flow";
import { runAnalysis, type AnalysisRunDeps } from "@/lib/state/ui/sync-runner";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import AssistantSettings from "./assistant-settings";
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
  // The app gave up analyzing this post after repeated failures; absent on older servers.
  analysis_failed?: boolean;
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
  // Set when pruning removed the audio to free space; the markdown stays.
  audio_pruned_at: string | null;
}

// What the result card shows once a brief is published.
interface BriefResult {
  episode: Episode;
  markdown?: string;
  stats?: { considered: number; droppedAsStale: number; excludedAsMisleading: number };
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

interface CapacityMeter {
  usedBytes: number;
  limitBytes: number;
  ratio: number; // used / limit
}

// GET /api/capacity. `recommendation` is a ready-to-show sentence, null while the level is "ok".
interface Capacity {
  storage: CapacityMeter;
  database: CapacityMeter;
  level: "ok" | "warn" | "critical";
  autoPrune: boolean;
  keepRecent: number;
  recommendation: string | null;
}

// POST /api/capacity/prune. With { dryRun: true } nothing is deleted and `pruned` is the preview.
interface PruneResponse {
  pruned: { episodeId: string; userId: string; title: string; createdAt: string }[];
  usedBytes: number;
  capacity: Capacity;
}

const percent = (m: CapacityMeter) => Math.round(m.ratio * 100);

// Pruning only brings storage back down to this share of its limit (WARN_RATIO in
// src/lib/capacity.ts), so it can free something only at or above it. Below that, a warning is
// about the database alone and gets no "Free up space" button.
const PRUNE_TARGET_RATIO = 0.8;

// 1024-based, so the 1 GiB / 500 MiB free-tier limits read as 1.0 GB / 500.0 MB.
function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
}

// The resumable banner's card, tinted by how full things are. "ok" only shows the
// "Freed space" confirmation, once a prune has brought the level back down.
const BANNER_TONES = {
  warn: {
    box: "border-amber-400/25 bg-amber-500/10",
    text: "text-amber-200",
    primary: "bg-amber-500 font-medium text-zinc-950 hover:bg-amber-400 focus-visible:ring-amber-300",
    secondary: "border border-amber-800/60 text-amber-200 hover:border-amber-600 focus-visible:ring-amber-300",
  },
  critical: {
    box: "border-red-400/25 bg-red-500/10",
    text: "text-red-200",
    primary: "bg-red-500 font-medium text-zinc-950 hover:bg-red-400 focus-visible:ring-red-300",
    secondary: "border border-red-800/60 text-red-200 hover:border-red-600 focus-visible:ring-red-300",
  },
  ok: {
    box: "border-emerald-400/25 bg-emerald-500/10",
    text: "text-emerald-200",
    primary: "bg-emerald-500 font-medium text-zinc-950 hover:bg-emerald-400 focus-visible:ring-emerald-300",
    secondary: "border border-emerald-800/60 text-emerald-200 hover:border-emerald-600 focus-visible:ring-emerald-300",
  },
} as const;

const BANNER_BUTTON =
  "rounded-full px-4 py-1.5 text-sm transition disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950";

// Stands where the player would be once pruning has removed an episode's audio.
function AudioRemoved({ episode }: { episode: Episode }) {
  if (episode.audio_url || !episode.audio_pruned_at) return null;
  const when = new Date(episode.audio_pruned_at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return (
    <p className="text-sm text-zinc-400">
      Audio removed on {when} to free space — the markdown is still here.
    </p>
  );
}

// The "Stop background" preference, saved in localStorage as "bb_bg". It is read through
// useSyncExternalStore instead of being copied into state by an effect. The server render and
// hydration use "on" (there is no localStorage there), and a saved "off" takes over right after
// hydration. The first read is cached, so a change made in another tab is picked up on the next
// page load, not partway through this one. Blocked storage reads as "on" and a failed save
// still applies for this page load (see background-pref.ts).
let bgOnCache: boolean | null = null;
const bgListeners = new Set<() => void>();

function subscribeBackground(listener: () => void) {
  bgListeners.add(listener);
  return () => {
    bgListeners.delete(listener);
  };
}

function getBackgroundOn(): boolean {
  bgOnCache ??= readBackgroundOn(() => localStorage);
  return bgOnCache;
}

const getBackgroundOnServer = () => true;

function saveBackgroundOn(on: boolean) {
  bgOnCache = on;
  for (const listener of bgListeners) listener();
  writeBackgroundOn(() => localStorage, on);
}

// GET /api/digest/status for one draft: the body, or null on 404 (deleted, or never this user's).
async function fetchDraftStatus(episodeId: string): Promise<DigestStatusResponse | null> {
  const res = await fetch(`/api/digest/status?episodeId=${encodeURIComponent(episodeId)}`);
  if (res.status === 404) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? "Couldn't check brief status");
  return body as DigestStatusResponse;
}

async function post(url: string, payload: Record<string, unknown>, fallbackError = `${url} failed`) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? fallbackError);
  return body;
}

// The analysis loop's requests keep the sync's own wording when the route gives no reason.
const postEnrich = (url: string, payload: Record<string, unknown>) => post(url, payload, "Analysis failed");

export default function Dashboard({
  user,
  greeting = "Welcome back",
}: {
  user: {
    handle: string;
    display_name: string | null;
    avatar_url: string | null;
    x_user_id?: string | null;
  };
  greeting?: string;
}) {
  const [format, setFormat] = useState<Format>("both");
  const [from, setFrom] = useState(isoDaysAgo(7));
  const [to, setTo] = useState(isoDaysAgo(0));
  const [selectedTopics, setSelectedTopics] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [list, dispatchList] = useReducer(listLoadReducer<Bookmark>, undefined, initialListLoad<Bookmark>);
  const [syncState, dispatchSync] = useReducer(syncReducer, SYNC_IDLE);
  const [brief, dispatchBrief] = useReducer(briefFlowReducer<BriefResult>, BRIEF_IDLE);
  const [banner, dispatchBanner] = useReducer(resumeBannerReducer, BANNER_NONE);
  const [elapsed, setElapsed] = useState(0);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [capacity, setCapacity] = useState<Capacity | null>(null);
  const [freeUp, dispatchFreeUp] = useReducer(freeUpReducer, FREE_UP_IDLE);
  // Numbers each Free up space check or prune, so a superseded run's answer is ignored.
  const freeUpRunRef = useRef(0);
  const bgVideoRef = useRef<HTMLVideoElement | null>(null);
  const bgOn = useSyncExternalStore(subscribeBackground, getBackgroundOn, getBackgroundOnServer);

  const bookmarks = listBookmarks(list);
  const topicCounts = listTopics(list);
  const libraryCount = listLibraryCount(list);
  const analysisFailed = listAnalysisFailed(list);
  const loading = list.step === "loading";
  const listSeq = list.seq;
  const syncing = syncBusy(syncState);
  const creating = brief.step === "working";
  const briefStartedAt = brief.step === "working" ? brief.startedAt : null;

  // Keep the video paused while the background is off. This covers a saved "off" applied after
  // hydration, which also pauses the autoPlay that may have already kicked off.
  useEffect(() => {
    if (!bgOn) bgVideoRef.current?.pause();
  }, [bgOn]);

  function toggleBackground() {
    const next = !bgOn;
    saveBackgroundOn(next);
    const video = bgVideoRef.current;
    if (!video) return;
    if (next) {
      // Called inside the click gesture, so playback starts immediately
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }

  // The bookmark list's query. Changing a filter changes it, and the fetch effect below reloads.
  const bookmarkQuery = useMemo(() => {
    const params = new URLSearchParams({ from, to });
    if (selectedTopics.length > 0) params.set("topics", selectedTopics.join(","));
    return params.toString();
  }, [from, to, selectedTopics]);

  // A filter change requests a new load in the same render, not a render later from the fetch
  // effect (react.dev, "You Might Not Need an Effect": adjusting state when a prop changes), so
  // the loading state shows at once. The initial state is already the first request.
  const [prevBookmarkQuery, setPrevBookmarkQuery] = useState(bookmarkQuery);
  if (bookmarkQuery !== prevBookmarkQuery) {
    setPrevBookmarkQuery(bookmarkQuery);
    dispatchList({ type: "request", reason: "filter" });
  }

  // Unfiltered library size from the last successful load, null until one lands. Nothing renders
  // it: it only tells the first-visit auto-sync which load found the library empty, so it's a ref.
  const libraryTotalRef = useRef<number | null>(null);

  // The date range as of the last commit. A sync names the range in its closing message, and
  // should name the one on screen when it finishes, not the one from when it started.
  const rangeRef = useRef({ from, to });
  useEffect(() => {
    rangeRef.current = { from, to };
  }, [from, to]);

  const loadEpisodes = useCallback(
    () =>
      fetch("/api/episodes").then(async (res) => {
        if (res.ok) setEpisodes((await res.json()).episodes ?? []);
      }),
    []
  );

  // Storage/database use for the status line and banner. Best-effort: purely informational.
  const loadCapacity = useCallback(
    () =>
      fetch("/api/capacity")
        .then((res) => (res.ok ? (res.json() as Promise<Capacity>) : null))
        .then((body) => {
          if (body) setCapacity(body);
        })
        .catch(() => {}),
    []
  );

  // Checks for an interrupted brief generation (refresh, network blip, TTS
  // hiccup) so it can be offered back as "Resume" instead of silently lost.
  const checkResumable = useCallback(
    () =>
      fetch("/api/digest/status")
        .then(async (res) => {
          if (!res.ok) return;
          const draft = draftFromStatus((await res.json()) as DigestStatusResponse);
          dispatchBanner(draft ? { type: "found", draft } : { type: "cleared" });
        })
        .catch(() => {
          // Best-effort: the resume banner is a convenience, not the critical path.
        }),
    []
  );

  const analysisDeps: AnalysisRunDeps = {
    post: postEnrich,
    onProgress: (done, total) => dispatchSync({ type: "progress", done, total }),
    onChunk: () => dispatchList({ type: "request", reason: "reload" }),
  };

  // Each list reload is a request the fetch effect below serves with the filters current when it
  // runs, so a reload partway through a long sync never re-applies the filters the sync began with.
  async function sync() {
    if (syncBusy(syncState)) return;
    dispatchSync({ type: "start" });
    dispatchList({ type: "dismissHideError" }); // the user has moved on from a failed hide
    try {
      // Fast: fetch from X + store. Bookmarks appear immediately.
      const res = await fetch("/api/sync", { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Sync failed");
      dispatchList({ type: "request", reason: "reload" });

      // Then ingest sources + analyze in short chunks; tags fill in as chunks land.
      const { analyzed } = await runAnalysis(body.pendingAnalysis ?? 0, analysisDeps);
      const range = rangeRef.current;
      dispatchSync({ type: "succeed", message: describeSync(body, range.from, range.to, analyzed) });
    } catch (err) {
      dispatchSync({ type: "fail", message: err instanceof Error ? err.message : "Sync failed" });
    }
  }

  // Retry: make the given-up posts candidates again and run only the analysis loop, through the
  // same flow as a sync so the progress panel and the disabled "Check X for new" come with it.
  async function retryFailedAnalysis() {
    if (syncBusy(syncState) || analysisFailed === 0) return;
    const total = analysisFailed;
    dispatchSync({ type: "retry", total });
    dispatchList({ type: "dismissHideError" }); // the user has moved on from a failed hide
    try {
      const { analyzed } = await runAnalysis(total, analysisDeps, { retryFailed: true });
      dispatchSync(retryOutcome(analyzed, total));
    } catch (err) {
      dispatchSync({ type: "fail", message: err instanceof Error ? err.message : "Analysis failed" });
    }
  }

  // First visit: an empty library means nothing has been synced yet, so pull bookmarks
  // automatically instead of waiting for a click, unless a sync is already running. An Effect
  // Event, so it sees the current sync state and `sync` without the fetch effect depending on them.
  const onLibraryFoundEmpty = useEffectEvent(() => {
    if (!syncing) sync();
  });

  // GET /api/bookmarks for the latest request: a filter change above, or a reload from sync, a
  // failed hide or Retry. The response carries its request's number, and the reducer keeps only
  // the latest, so an older answer arriving late can't replace a newer list. Like the other
  // loaders the effects call, it dispatches only inside .then/.catch callbacks:
  // react-hooks/set-state-in-effect treats a setState after an await in an async function as
  // synchronous, so an effect calling one would be flagged.
  useEffect(() => {
    // Cleared once a newer request (or an unmount) supersedes this one. It gates the
    // first-visit check, which must only ever see the latest load.
    let current = true;
    fetch(`/api/bookmarks?${bookmarkQuery}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Bookmarks load failed (${res.status})`);
        const body = await res.json();
        const total: number = body.total ?? 0;
        const data: ListData<Bookmark> = {
          bookmarks: body.bookmarks ?? [],
          topics: body.topics ?? [],
          library: body.library ?? total,
          analysisFailed: body.analysisFailed ?? 0,
        };
        dispatchList({ type: "succeed", seq: listSeq, data });
        if (!current) return;
        // True when this load found the library empty and the previous successful load didn't
        // (or there was none yet): the first-visit case.
        const becameEmpty = total === 0 && libraryTotalRef.current !== 0;
        libraryTotalRef.current = total;
        if (becameEmpty) onLibraryFoundEmpty();
      })
      .catch(() => dispatchList({ type: "fail", seq: listSeq }));
    return () => {
      current = false;
    };
  }, [bookmarkQuery, listSeq]);

  useEffect(() => {
    loadEpisodes().catch(() => {}); // best-effort: a failed history load just leaves it empty
  }, [loadEpisodes]);

  useEffect(() => {
    loadCapacity();
  }, [loadCapacity]);

  useEffect(() => {
    checkResumable();
  }, [checkResumable]);

  // Ticking clock while a brief is being created, so it never looks frozen
  useEffect(() => {
    if (!briefStartedAt) return;
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - briefStartedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [briefStartedAt]);

  const onBriefStage = (stage: BriefStage) => dispatchBrief({ type: "stage", stage });

  // Starting a create or resume clears only the brief flow's own errors.
  function beginBrief(stage: BriefStage) {
    dispatchBrief({ type: "start", startedAt: Date.now(), stage });
    dispatchBanner({ type: "clearError" });
    dispatchFreeUp({ type: "reset" }); // a new brief makes any earlier "Freed space" line stale
    setElapsed(0);
  }

  // Once a brief is published, refreshing the history and the meter is best-effort: the brief is
  // done, and a failure here must never turn the result into an error.
  function refreshAfterBrief() {
    loadCapacity();
    loadEpisodes().catch(() => {});
  }

  // On any stage failure the draft row is left in place on purpose (nothing here deletes it) so
  // it's resumable. The banner is re-checked on every failure, not only when the episode id is
  // known: a prepare that timed out may still have created a draft whose id never reached us.
  function reportBriefFailure(err: unknown, episodeId: string | undefined) {
    dispatchBrief({ type: "fail", message: briefFailureMessage(err, episodeId) });
    checkResumable();
    // Finalize answers 507 when storage is full and auto-prune is off: refresh the banner.
    loadCapacity();
  }

  async function createBrief() {
    if (creating) return;
    beginBrief({ step: "preparing" });
    let episodeId: string | undefined;
    try {
      // Stage 1: analyze, check freshness, outline, write the markdown brief
      const prepared = await post("/api/digest/prepare", {
        format,
        from,
        to,
        topics: selectedTopics,
        // Hand-picked posts take precedence over date/topic filters
        tweetIds: selected.size > 0 ? [...selected] : undefined,
        targetMinutes: TARGET_MINUTES,
      });
      if (prepared.done) {
        dispatchBrief({ type: "succeed", result: prepared });
      } else {
        episodeId = prepared.episode.id as string;
        dispatchBanner({ type: "cleared" }); // starting fresh supersedes any stale resumable draft
        const finalized = await runAudioStages<{ episode: Episode }>(episodeId, {
          post,
          onStage: onBriefStage,
        });
        dispatchBrief({
          type: "succeed",
          result: { episode: finalized.episode, markdown: prepared.markdown, stats: prepared.stats },
        });
      }
    } catch (err) {
      reportBriefFailure(err, episodeId);
      return;
    }
    refreshAfterBrief();
  }

  // Resumes from the draft's stage as the server reports it now (another tab or the background
  // job runner may have moved it on), not the stage cached when the banner was shown.
  async function resumeBrief() {
    if (banner.step !== "available" || creating) return;
    const draft = banner.draft;
    beginBrief(resumeStartStage(draft));
    let outcome: ResumeOutcome<{ episode: Episode }>;
    try {
      outcome = await resumeDraft<{ episode: Episode }>(draft.episodeId, {
        post,
        getStatus: fetchDraftStatus,
        onStage: onBriefStage,
      });
    } catch (err) {
      reportBriefFailure(err, draft.episodeId);
      return;
    }
    dispatchBanner({ type: "cleared" });
    switch (outcome.kind) {
      case "published":
        dispatchBrief({ type: "succeed", result: { episode: outcome.finalized.episode } });
        refreshAfterBrief();
        break;
      case "finished":
        // Finished elsewhere: nothing went wrong, and the history list will show it.
        dispatchBrief({ type: "stop" });
        refreshAfterBrief();
        break;
      case "gone":
        dispatchBrief({ type: "fail", message: DRAFT_GONE_MESSAGE });
        break;
      default: {
        const unreachable: never = outcome;
        return unreachable;
      }
    }
  }

  async function discardResumable() {
    if (banner.step !== "available" || creating) return;
    const { episodeId } = banner.draft;
    dispatchBanner({ type: "discard" });
    dispatchBrief({ type: "clearError" });
    try {
      const res = await fetch(`/api/digest/status?episodeId=${episodeId}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Couldn't discard draft");
      }
      dispatchBanner({ type: "discarded" });
    } catch (err) {
      dispatchBanner({
        type: "discardFailed",
        message: err instanceof Error ? err.message : "Couldn't discard draft",
      });
    }
  }

  // "Free up space": preview with a dry run, confirm, then prune for real. The server only ever
  // touches the caller's own audio and always keeps their newest briefs.
  async function startFreeUp() {
    const run = ++freeUpRunRef.current;
    dispatchFreeUp({ type: "check", run });
    try {
      const body: PruneResponse = await post("/api/capacity/prune", { dryRun: true });
      dispatchFreeUp({ type: "checked", run, titles: body.pruned.map((p) => p.title) });
    } catch (err) {
      dispatchFreeUp({
        type: "failed",
        run,
        message: err instanceof Error ? err.message : "Couldn't check what can be removed",
      });
    }
  }

  async function confirmFreeUp() {
    const run = ++freeUpRunRef.current;
    dispatchFreeUp({ type: "prune", run });
    try {
      const body: PruneResponse = await post("/api/capacity/prune", { dryRun: false });
      setCapacity(body.capacity); // show the new level now; the refetch below confirms it
      dispatchFreeUp({
        type: "pruned",
        run,
        removed: body.pruned.length,
        pct: percent(body.capacity.storage),
      });
      loadCapacity();
      loadEpisodes().catch(() => {}); // best-effort: the prune itself already succeeded
    } catch (err) {
      dispatchFreeUp({
        type: "failed",
        run,
        message: err instanceof Error ? err.message : "Couldn't free up space",
      });
    }
  }

  const toggleTopic = (topic: string) =>
    setSelectedTopics((prev) =>
      prev.includes(topic) ? prev.filter((t) => t !== topic) : [...prev, topic]
    );

  // The sync's done message names the date range, so a range change retires it.
  const changeRange = (bound: "from" | "to", value: string) => {
    if (bound === "from") setFrom(value);
    else setTo(value);
    dispatchSync({ type: "dismiss" });
  };

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
    dispatchList({ type: "hide", tweetId });
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(tweetId);
      return next;
    });
    let saved = false;
    try {
      const res = await fetch("/api/bookmarks/hide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tweet_id: tweetId }),
      });
      saved = res.ok;
    } catch {
      // A network failure is handled like a refusal below.
    }
    if (!saved) {
      dispatchList({ type: "hideFailed", message: HIDE_FAILED_MESSAGE });
      dispatchList({ type: "request", reason: "reload" });
    }
  }

  const formatOptions: { value: Format; label: string }[] = useMemo(
    () => [
      { value: "markdown", label: "Markdown" },
      { value: "both", label: "Markdown + Podcast" },
    ],
    []
  );

  const bannerTone = BANNER_TONES[capacity?.level ?? "ok"];
  const freeUpText = freeUpMessage(freeUp);
  const freeUpBusy = isFreeUpBusy(freeUp);
  const canFreeUp = (capacity?.storage.ratio ?? 0) >= PRUNE_TARGET_RATIO;
  const freeUpLabel = freeUpButtonLabel(freeUp, canFreeUp);

  // Every unanalyzed post in view is one the app gave up on, so "Check X for new" wouldn't
  // analyze any of them; the Retry notice already explains.
  const unanalyzed = bookmarks.filter((b) => !analysisOf(b));
  const onlyGivenUpUnanalyzed = unanalyzed.length > 0 && unanalyzed.every((b) => b.analysis_failed === true);

  const syncStage = syncStageLabel(syncState);
  const syncProgress = syncProgressOf(syncState);
  const syncMessage = syncDoneMessage(syncState);
  // One error line per flow, so a failure in one never overwrites another's.
  const errorLines = Object.entries({
    sync: syncErrorMessage(syncState),
    brief: briefErrorMessage(brief, banner),
    list: list.hideError,
  }).filter((line): line is [string, string] => line[1] !== null);
  const createStage = brief.step === "working" ? briefStageLabel(brief.stage) : null;
  const createProgress = brief.step === "working" ? briefProgress(brief.stage) : null; // 0..1, null = indeterminate
  const result = brief.step === "succeeded" ? brief.result : null;
  const resumable = banner.step === "none" ? null : banner.draft;
  const resumeControls = bannerControls(banner, brief);

  // Byte counts are in the tooltip; the line itself stays tiny.
  const capacityLine = capacity && (
    <p
      className="text-xs text-zinc-500"
      title={`Storage ${formatBytes(capacity.storage.usedBytes)} of ${formatBytes(capacity.storage.limitBytes)} · Database ${formatBytes(capacity.database.usedBytes)} of ${formatBytes(capacity.database.limitBytes)}`}
    >
      Storage {percent(capacity.storage)}% · Database {percent(capacity.database)}%
    </p>
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
            {user.x_user_id && (
              <span
                title="Put this in ALLOWED_X_USER_IDS to restrict who can sign in"
                className="px-2 py-2 text-sm text-zinc-500"
              >
                X user ID <span className="select-all tabular-nums">{user.x_user_id}</span>
              </span>
            )}
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
          {analysisFailed > 0 && !syncing && (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-amber-400">{describeAnalysisFailed(analysisFailed)}</p>
              <button
                onClick={retryFailedAnalysis}
                disabled={syncing}
                className="rounded-full border border-white/15 bg-white/5 px-4 py-2 text-sm backdrop-blur-md transition hover:border-white/30 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
              >
                Retry
              </button>
            </div>
          )}
          {errorLines.map(([flow, message]) => (
            <p key={flow} className="text-sm text-red-400">
              {message}
            </p>
          ))}
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
                disabled={resumeControls.resumeDisabled}
                className="rounded-full bg-amber-500 px-4 py-1.5 text-sm font-medium text-zinc-950 transition hover:bg-amber-400 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
              >
                Resume
              </button>
              <button
                onClick={discardResumable}
                disabled={resumeControls.discardDisabled}
                className="rounded-full border border-amber-800/60 px-4 py-1.5 text-sm text-amber-200 transition hover:border-amber-600 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
              >
                {resumeControls.discardLabel}
              </button>
            </div>
          </section>
        )}

        {/* Capacity banner: amber when filling up, red when nearly full. It also stays up after a
            prune so the "Freed space" confirmation is seen even once the level is back to ok. */}
        {capacity && (capacity.level !== "ok" || freeUp.step !== "idle") && (
          <section
            className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-4 backdrop-blur-xl ${bannerTone.box}`}
          >
            <div
              aria-live="polite"
              className={`min-w-0 grow basis-56 space-y-1 text-sm ${bannerTone.text}`}
            >
              {capacity.recommendation && <p>{capacity.recommendation}</p>}
              {freeUpText && (
                <p className={freeUp.step === "error" ? "text-red-300" : undefined}>{freeUpText}</p>
              )}
            </div>
            {/* A database-only warning has no button (audio pruning only frees storage). Controls
                come back only while a Free up space message is showing, so it can be dismissed. */}
            {(canFreeUp || freeUp.step !== "idle") && (
              <div className="flex shrink-0 items-center gap-2">
                {freeUp.step === "confirm" ? (
                  <>
                    <button onClick={confirmFreeUp} className={`${BANNER_BUTTON} ${bannerTone.primary}`}>
                      Confirm
                    </button>
                    {/* The prompt replaces the button that was just pressed, so focus is placed on
                        the safe choice instead of being dropped. */}
                    <button
                      onClick={() => dispatchFreeUp({ type: "reset" })}
                      autoFocus
                      className={`${BANNER_BUTTON} ${bannerTone.secondary}`}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    onClick={canFreeUp ? startFreeUp : () => dispatchFreeUp({ type: "reset" })}
                    disabled={freeUpBusy}
                    className={`${BANNER_BUTTON} ${canFreeUp ? bannerTone.primary : bannerTone.secondary}`}
                  >
                    {freeUpLabel}
                  </button>
                )}
              </div>
            )}
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
                  onChange={(e) => changeRange("from", e.target.value)}
                  className="ml-1 rounded-lg border border-white/15 bg-zinc-900/50 px-3 py-1.5 text-zinc-100 backdrop-blur-md [color-scheme:dark] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                />
              </label>
              <label className="text-sm text-zinc-400">
                and{" "}
                <input
                  type="date"
                  aria-label="Posted on or before"
                  value={to}
                  onChange={(e) => changeRange("to", e.target.value)}
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
                  : list.step === "failed" && list.data === null
                    ? ""
                    : bookmarks.length === 0
                    ? "No posts in this date range, so no topics to show. Widen the dates to see more."
                    : onlyGivenUpUnanalyzed
                      ? ""
                      : "No topics yet for these posts — use Check X for new to analyze them."}
            </p>
          )}
        </section>

        {/* Voices */}
        <VoiceSettings />

        {/* Assistants (MCP connector tokens) */}
        <AssistantSettings />

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
            <AudioRemoved episode={result.episode} />
            <div className="flex flex-wrap gap-3">
              {result.episode.markdown_url && (
                <a
                  href={result.episode.markdown_url}
                  download="bookmark-graveyard-brief.md"
                  className="rounded-full border border-white/15 bg-white/5 px-4 py-2 text-sm backdrop-blur-md transition hover:border-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
                >
                  Download .md
                </a>
              )}
              {result.episode.audio_url && (
                <a
                  href={result.episode.audio_url}
                  download="bookmark-graveyard-brief.mp3"
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
              ? list.step === "failed"
                ? ""
                : "Loading…"
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
          {list.step === "failed" && (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-red-400">{LIST_LOAD_FAILED_MESSAGE}</p>
              <button
                onClick={() => dispatchList({ type: "request", reason: "reload" })}
                className="rounded-full border border-white/15 bg-white/5 px-4 py-2 text-sm backdrop-blur-md transition hover:border-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
              >
                Retry
              </button>
            </div>
          )}
          {list.step === "loaded" && bookmarks.length === 0 && (
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
                        {syncing && !b.analysis_failed && (
                          <span className="inline-block h-1.5 w-1.5 rounded-full bg-sky-400 animate-pulse" />
                        )}
                        {b.analysis_failed ? "Couldn't analyze" : syncing ? "Analyzing…" : "Not analyzed yet"}
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
            <div className="space-y-1">
              <h2 className="font-heading text-2xl tracking-wide text-zinc-100">
                Previous briefs
              </h2>
              {capacityLine}
            </div>
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
                  <AudioRemoved episode={ep} />
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
        {episodes.length === 0 && capacityLine}
      </div>
    </main>
  );
}
