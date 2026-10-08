/**
 * Copy helpers for the dashboard. Pure functions so the wording that explains
 * sync-vs-filter behavior can be unit-tested without rendering React.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type SyncSummary = {
  fetched: number;
  new: number;
  newBookmarks?: { tweet_id: string; tweet_created_at: string | null }[];
};

/**
 * Post-sync message that keeps "what X returned" separate from "what the
 * current date window shows". A sync always pulls the whole library, so new
 * posts can land outside the visible range and would otherwise seem to vanish.
 */
export function describeSync(body: SyncSummary, from: string, to: string, analyzed: number): string {
  const parts = [`Checked X: ${body.fetched} bookmarks, ${body.new} new since last time`];
  if (body.new > 0) {
    const toBound = `${to}T23:59:59Z`;
    const outside = (body.newBookmarks ?? []).filter(
      (b) => b.tweet_created_at !== null && (b.tweet_created_at < from || b.tweet_created_at > toBound)
    ).length;
    parts.push(
      outside === 0 ? "all within your current date range" : `${outside} outside your current date range`
    );
  }
  if (analyzed > 0) parts.push(`${analyzed} analyzed`);
  return `${parts.join(", ")}.`;
}

/** "Sep 14 to Oct 5", adding years only when the range crosses a year boundary. */
export function formatRange(from: string, to: string): string {
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) return "in the selected range";
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  const day = (iso: string) =>
    new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      ...(sameYear ? {} : { year: "numeric" }),
    });
  return `${day(from)} to ${day(to)}`;
}

/** Rotating dashboard greetings; the server picks one per page load. */
export const GREETINGS = [
  "Welcome back",
  "Hello",
  "Welcome",
  "Glad you're here",
  "Time to revive",
  "Boo",
  "Back from the dead",
  "The graveyard stirs",
] as const;

/**
 * One greeting at random. Lives here (not in the page component) so the React
 * purity rule doesn't see Math.random() during render: the server component
 * calls it once per request, and the client never re-runs it.
 */
export function pickGreeting(random: () => number = Math.random): string {
  const index = Math.min(GREETINGS.length - 1, Math.max(0, Math.floor(random() * GREETINGS.length)));
  return GREETINGS[index];
}
