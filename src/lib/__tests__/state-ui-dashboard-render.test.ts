// Smoke test: the dashboard server-renders without throwing, so the reducer wiring holds
// together on first render. Effects don't run in renderToString, so nothing is fetched.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Dashboard from "../../app/dashboard";

describe("Dashboard server render", () => {
  it("renders the first paint with its headings and buttons", () => {
    const html = renderToString(
      createElement(Dashboard, {
        user: { handle: "someone", display_name: "Some One", avatar_url: null },
        greeting: "Hello",
      })
    );
    expect(html).toContain("How would you like your summary?");
    expect(html).toContain("Your bookmarks");
    expect(html).toContain("Check X for new");
    expect(html).toContain("Stop background");
    expect(html).toContain("Loading…");
    expect(html).not.toContain("Couldn&#x27;t load your bookmarks.");
  });
});
