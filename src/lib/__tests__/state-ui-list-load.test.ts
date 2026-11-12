import { describe, expect, it } from "vitest";
import {
  HIDE_FAILED_MESSAGE,
  LIST_LOAD_FAILED_MESSAGE,
  initialListLoad,
  listAnalysisFailed,
  listBookmarks,
  listLibraryCount,
  listLoadReducer,
  listTopics,
  type ListData,
  type ListLoad,
  type ListLoadEvent,
} from "../state/ui/list-load";

type B = { tweet_id: string };
type State = ListLoad<B>;
type Event = ListLoadEvent<B>;

const oldData: ListData<B> = { bookmarks: [{ tweet_id: "1" }, { tweet_id: "2" }], topics: [], library: 2, analysisFailed: 0 };
const newData: ListData<B> = { bookmarks: [{ tweet_id: "3" }], topics: [{ name: "ai", count: 1 }], library: 3, analysisFailed: 4 };

const states: Record<State["step"], State> = {
  loading: { step: "loading", seq: 4, data: oldData, hideError: null },
  loaded: { step: "loaded", seq: 4, data: oldData, hideError: null },
  failed: { step: "failed", seq: 4, data: oldData, hideError: null },
};

const events: Record<string, Event> = {
  request: { type: "request", reason: "reload" },
  requestFilter: { type: "request", reason: "filter" },
  dismissHideError: { type: "dismissHideError" },
  succeedLatest: { type: "succeed", seq: 4, data: newData },
  succeedStale: { type: "succeed", seq: 3, data: newData },
  failLatest: { type: "fail", seq: 4 },
  failStale: { type: "fail", seq: 3 },
  hide: { type: "hide", tweetId: "1" },
  hideMissing: { type: "hide", tweetId: "nope" },
  hideFailed: { type: "hideFailed", message: HIDE_FAILED_MESSAGE },
};

const hidden: ListData<B> = { ...oldData, bookmarks: [{ tweet_id: "2" }] };

const table: Record<State["step"], Record<string, State | "same">> = {
  loading: {
    request: { step: "loading", seq: 5, data: oldData, hideError: null },
    requestFilter: { step: "loading", seq: 5, data: oldData, hideError: null },
    dismissHideError: "same",
    succeedLatest: { step: "loaded", seq: 4, data: newData, hideError: null },
    succeedStale: "same",
    failLatest: { step: "failed", seq: 4, data: oldData, hideError: null },
    failStale: "same",
    hide: { step: "loading", seq: 4, data: hidden, hideError: null },
    hideMissing: "same",
    hideFailed: { step: "loading", seq: 4, data: oldData, hideError: HIDE_FAILED_MESSAGE },
  },
  loaded: {
    request: { step: "loading", seq: 5, data: oldData, hideError: null },
    requestFilter: { step: "loading", seq: 5, data: oldData, hideError: null },
    dismissHideError: "same",
    succeedLatest: "same",
    succeedStale: "same",
    failLatest: "same",
    failStale: "same",
    hide: { step: "loaded", seq: 4, data: hidden, hideError: null },
    hideMissing: "same",
    hideFailed: { step: "loaded", seq: 4, data: oldData, hideError: HIDE_FAILED_MESSAGE },
  },
  failed: {
    request: { step: "loading", seq: 5, data: oldData, hideError: null },
    requestFilter: { step: "loading", seq: 5, data: oldData, hideError: null },
    dismissHideError: "same",
    succeedLatest: "same",
    succeedStale: "same",
    failLatest: "same",
    failStale: "same",
    hide: { step: "failed", seq: 4, data: hidden, hideError: null },
    hideMissing: "same",
    hideFailed: { step: "failed", seq: 4, data: oldData, hideError: HIDE_FAILED_MESSAGE },
  },
};

describe("listLoadReducer", () => {
  for (const [step, row] of Object.entries(table) as [State["step"], Record<string, State | "same">][]) {
    for (const [name, expected] of Object.entries(row)) {
      it(`${step} + ${name}`, () => {
        const state = states[step];
        const next = listLoadReducer(state, events[name]);
        if (expected === "same") expect(next).toBe(state);
        else expect(next).toEqual(expected);
      });
    }
  }

  it("latest wins: an older response landing after a newer one changes nothing", () => {
    let s: State = initialListLoad<B>(); // request 1, the first load
    s = listLoadReducer(s, { type: "request", reason: "filter" }); // request 2, a quick filter change
    expect(s.seq).toBe(2);
    s = listLoadReducer(s, { type: "succeed", seq: 2, data: newData });
    const afterNewer = s;
    s = listLoadReducer(s, { type: "succeed", seq: 1, data: oldData });
    expect(s).toBe(afterNewer);
    expect(listBookmarks(s)).toEqual(newData.bookmarks);
  });

  it("latest wins: an older response landing first neither shows nor ends the newer load", () => {
    let s: State = initialListLoad<B>();
    s = listLoadReducer(s, { type: "request", reason: "reload" });
    const pending = s;
    expect(listLoadReducer(s, { type: "succeed", seq: 1, data: oldData })).toBe(pending);
    expect(listLoadReducer(s, { type: "fail", seq: 1 })).toBe(pending);
    expect(s.step).toBe("loading");
  });

  it("a failed load ends in failed, never stuck loading, and Retry starts the next request", () => {
    let s: State = initialListLoad<B>();
    s = listLoadReducer(s, { type: "fail", seq: 1 });
    expect(s).toEqual({ step: "failed", seq: 1, data: null, hideError: null });
    s = listLoadReducer(s, { type: "request", reason: "reload" });
    expect(s).toEqual({ step: "loading", seq: 2, data: null, hideError: null });
  });

  it("a reload keeps the hide error until the next hide", () => {
    let s: State = listLoadReducer(states.loaded, { type: "hideFailed", message: HIDE_FAILED_MESSAGE });
    s = listLoadReducer(s, { type: "request", reason: "reload" });
    s = listLoadReducer(s, { type: "succeed", seq: s.seq, data: oldData });
    expect(s.hideError).toBe(HIDE_FAILED_MESSAGE);
    s = listLoadReducer(s, { type: "hide", tweetId: "2" });
    expect(s.hideError).toBeNull();
  });

  describe("the hide error goes away once the user moves on", () => {
    const withError: State = { ...states.loaded, hideError: HIDE_FAILED_MESSAGE };

    it("a filter change clears it", () => {
      expect(listLoadReducer(withError, { type: "request", reason: "filter" })).toEqual({
        step: "loading",
        seq: 5,
        data: oldData,
        hideError: null,
      });
    });

    it("starting a sync clears it, and is a no-op when there is none", () => {
      expect(listLoadReducer(withError, { type: "dismissHideError" })).toEqual(states.loaded);
      expect(listLoadReducer(states.loaded, { type: "dismissHideError" })).toBe(states.loaded);
    });

    it("the next hide clears it", () => {
      expect(listLoadReducer(withError, { type: "hide", tweetId: "1" }).hideError).toBeNull();
    });

    it("a plain reload (the hide's own, a sync's, Retry) keeps it", () => {
      const reloading = listLoadReducer(withError, { type: "request", reason: "reload" });
      expect(reloading).toEqual({ step: "loading", seq: 5, data: oldData, hideError: HIDE_FAILED_MESSAGE });
      const landed = listLoadReducer(reloading, { type: "succeed", seq: 5, data: newData });
      expect(landed.hideError).toBe(HIDE_FAILED_MESSAGE);
    });
  });

  it("hiding with no list loaded is a no-op unless it clears an error", () => {
    const empty = initialListLoad<B>();
    expect(listLoadReducer(empty, { type: "hide", tweetId: "1" })).toBe(empty);
    const withError: State = { ...empty, hideError: "x" };
    expect(listLoadReducer(withError, { type: "hide", tweetId: "1" })).toEqual(empty);
  });
});

describe("list selectors", () => {
  it("read the last data, with stable empties before any lands", () => {
    const first = initialListLoad<B>();
    expect(listBookmarks(first)).toEqual([]);
    expect(listBookmarks(first)).toBe(listBookmarks(initialListLoad<B>()));
    expect(listTopics(first)).toBe(listTopics(initialListLoad<B>()));
    expect(listLibraryCount(first)).toBeNull();
    expect(listLibraryCount(states.loaded)).toBe(2);
    expect(listTopics({ ...states.loaded, data: newData })).toEqual([{ name: "ai", count: 1 }]);
  });

  it("read the given-up count, 0 before any load lands", () => {
    expect(listAnalysisFailed(initialListLoad<B>())).toBe(0);
    expect(listAnalysisFailed(states.loaded)).toBe(0);
    expect(listAnalysisFailed({ ...states.loaded, data: newData })).toBe(4);
    expect(listAnalysisFailed({ ...states.loading, data: newData })).toBe(4);
  });

  it("use the wording the dashboard shows", () => {
    expect(LIST_LOAD_FAILED_MESSAGE).toBe("Couldn't load your bookmarks.");
    expect(HIDE_FAILED_MESSAGE).toBe("Couldn't remove that bookmark — it may reappear on reload.");
  });
});
