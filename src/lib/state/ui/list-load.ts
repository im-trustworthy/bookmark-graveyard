/**
 * The bookmark list's load state. Every request gets the next sequence number, and a response
 * only lands if it carries the latest one, so two quick filter changes that resolve out of
 * order can't put the older list on screen. The last list stays in `data` while a reload is in
 * flight (or after one fails), so the page doesn't blank out between filters.
 */

export interface TopicCount {
  name: string;
  count: number;
}

export interface ListData<B> {
  bookmarks: B[];
  topics: TopicCount[];
  library: number;
  // Non-hidden posts across the whole library that the app gave up analyzing, not just this view.
  analysisFailed: number;
}

interface Common {
  // The latest request's number. Responses carrying any other number are stale.
  seq: number;
  // The last failed hide, shown with the other errors. A plain reload keeps it; the next hide, a
  // filter change or a sync clears it.
  hideError: string | null;
}

export type ListLoad<B> =
  | (Common & { step: "loading"; data: ListData<B> | null })
  | (Common & { step: "loaded"; data: ListData<B> })
  | (Common & { step: "failed"; data: ListData<B> | null });

export type ListLoadEvent<B> =
  // A filter change moves the user on, so it retires the hide error. A plain reload (Retry, a
  // sync's mid-run reloads, the reload a failed hide triggers) keeps it, or it would vanish
  // before anyone could read it.
  | { type: "request"; reason: "filter" | "reload" }
  // The user moved on some other way (a sync started).
  | { type: "dismissHideError" }
  | { type: "succeed"; seq: number; data: ListData<B> }
  | { type: "fail"; seq: number }
  // Optimistic hide: drop the row now, persist in the background.
  | { type: "hide"; tweetId: string }
  | { type: "hideFailed"; message: string };

export const LIST_LOAD_FAILED_MESSAGE = "Couldn't load your bookmarks.";
export const HIDE_FAILED_MESSAGE = "Couldn't remove that bookmark — it may reappear on reload.";

// The first load is already under way when the page mounts.
export function initialListLoad<B>(): ListLoad<B> {
  return { step: "loading", seq: 1, data: null, hideError: null };
}

export function listLoadReducer<B extends { tweet_id: string }>(
  state: ListLoad<B>,
  event: ListLoadEvent<B>
): ListLoad<B> {
  switch (event.type) {
    case "request":
      return {
        step: "loading",
        seq: state.seq + 1,
        data: state.data,
        hideError: event.reason === "filter" ? null : state.hideError,
      };
    case "dismissHideError":
      return state.hideError === null ? state : { ...state, hideError: null };
    case "succeed":
      if (state.step !== "loading" || event.seq !== state.seq) return state;
      return { step: "loaded", seq: state.seq, data: event.data, hideError: state.hideError };
    case "fail":
      if (state.step !== "loading" || event.seq !== state.seq) return state;
      return { step: "failed", seq: state.seq, data: state.data, hideError: state.hideError };
    case "hide": {
      const data = state.data;
      if (!data || !data.bookmarks.some((b) => b.tweet_id === event.tweetId)) {
        return state.hideError === null ? state : { ...state, hideError: null };
      }
      const next = { ...data, bookmarks: data.bookmarks.filter((b) => b.tweet_id !== event.tweetId) };
      return { ...state, data: next, hideError: null };
    }
    case "hideFailed":
      return { ...state, hideError: event.message };
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

// Shared empties, so a list with no data yet hands memos the same array on every render.
const NO_BOOKMARKS: never[] = [];
const NO_TOPICS: TopicCount[] = [];

export function listBookmarks<B>(state: ListLoad<B>): B[] {
  return state.data?.bookmarks ?? NO_BOOKMARKS;
}

export function listTopics<B>(state: ListLoad<B>): TopicCount[] {
  return state.data?.topics ?? NO_TOPICS;
}

/** Unfiltered library size from the last successful load, null until one lands. */
export function listLibraryCount<B>(state: ListLoad<B>): number | null {
  return state.data?.library ?? null;
}

/** Posts the app gave up analyzing, from the last successful load; 0 until one lands. */
export function listAnalysisFailed<B>(state: ListLoad<B>): number {
  return state.data?.analysisFailed ?? 0;
}
