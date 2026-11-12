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

const posts = (n: number) => (n === 1 ? "1 post" : `${n} posts`);

/** The notice next to Retry, for posts the app gave up analyzing. */
export function describeAnalysisFailed(count: number): string {
  return `${posts(count)} couldn't be analyzed.`;
}

/**
 * Closing message for a Retry, given how many posts it analyzed and how many given-up posts it
 * started with. It names no count of posts still given up: a retry can also analyze posts that
 * were merely pending, so that number is only known after the next list load, and the notice
 * line reports it.
 */
export function describeRetry(analyzed: number, retried: number): string {
  if (analyzed > 0) return `Analyzed ${analyzed} more ${analyzed === 1 ? "post" : "posts"}.`;
  return retried === 1 ? "That post still couldn't be analyzed." : "Those posts still couldn't be analyzed.";
}

/**
 * How a Retry ends, shaped as the sync flow's closing event: it succeeded only if it analyzed at
 * least one post. One that got nowhere is a failure, so it is drawn as an error line, not in the
 * success style above a notice that says the same thing.
 */
export function retryOutcome(analyzed: number, retried: number): { type: "succeed" | "fail"; message: string } {
  return { type: analyzed > 0 ? "succeed" : "fail", message: describeRetry(analyzed, retried) };
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
