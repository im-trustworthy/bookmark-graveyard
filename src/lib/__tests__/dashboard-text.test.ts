import { describe, expect, it } from "vitest";
import { GREETINGS, describeSync, formatRange, pickGreeting } from "../dashboard-text";

describe("describeSync", () => {
  it("reports a no-op check without mentioning the date range", () => {
    expect(describeSync({ fetched: 96, new: 0, newBookmarks: [] }, "2026-09-28", "2026-10-05", 0)).toBe(
      "Checked X: 96 bookmarks, 0 new since last time."
    );
  });

  it("counts new posts that fall outside the visible window", () => {
    const body = {
      fetched: 99,
      new: 3,
      newBookmarks: [
        { tweet_id: "1", tweet_created_at: "2026-10-01T10:00:00.000Z" }, // inside
        { tweet_id: "2", tweet_created_at: "2019-11-01T13:38:39.000Z" }, // old post, outside
        { tweet_id: "3", tweet_created_at: "2026-10-06T00:00:01.000Z" }, // after `to`, outside
      ],
    };
    expect(describeSync(body, "2026-09-28", "2026-10-05", 3)).toBe(
      "Checked X: 99 bookmarks, 3 new since last time, 2 outside your current date range, 3 analyzed."
    );
  });

  it("treats undated posts as inside the window, matching the API filter", () => {
    const body = { fetched: 1, new: 1, newBookmarks: [{ tweet_id: "1", tweet_created_at: null }] };
    expect(describeSync(body, "2026-09-28", "2026-10-05", 0)).toBe(
      "Checked X: 1 bookmarks, 1 new since last time, all within your current date range."
    );
  });

  it("includes posts on the `to` day itself", () => {
    const body = { fetched: 1, new: 1, newBookmarks: [{ tweet_id: "1", tweet_created_at: "2026-10-05T23:30:00.000Z" }] };
    expect(describeSync(body, "2026-09-28", "2026-10-05", 0)).toContain("all within");
  });
});

describe("formatRange", () => {
  it("omits the year inside a single year", () => {
    expect(formatRange("2026-09-14", "2026-10-05")).toBe("Sep 14 to Oct 5");
  });

  it("adds years when the range crosses a year boundary", () => {
    expect(formatRange("2025-12-20", "2026-01-03")).toBe("Dec 20, 2025 to Jan 3, 2026");
  });

  it("falls back to neutral wording when a picker is cleared", () => {
    expect(formatRange("", "2026-10-05")).toBe("in the selected range");
  });
});

describe("pickGreeting", () => {
  it("returns the first greeting for 0 and the last for values just under 1", () => {
    expect(pickGreeting(() => 0)).toBe(GREETINGS[0]);
    expect(pickGreeting(() => 0.999999)).toBe(GREETINGS[GREETINGS.length - 1]);
  });

  it("always returns a known greeting with the real random source", () => {
    for (let i = 0; i < 50; i++) expect(GREETINGS).toContain(pickGreeting());
  });
});
