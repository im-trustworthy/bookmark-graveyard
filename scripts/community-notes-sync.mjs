#!/usr/bin/env node
/**
 * Nightly Community Notes sync.
 *
 * X publishes the full Community Notes dataset as public TSV downloads
 * (https://communitynotes.x.com/guide/en/under-the-hood/download-data).
 * There is no API to read the note on an arbitrary post, so we stream the
 * daily files and keep only rows whose tweetId matches one of our bookmarks.
 *
 * Runs in GitHub Actions (see .github/workflows/community-notes.yml) because
 * the files are multi-GB — too large for serverless functions.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { createInterface } from "node:readline";
import { Readable } from "node:stream";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const headers = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

async function fetchBookmarkedTweetIds() {
  const ids = new Set();
  let offset = 0;
  for (;;) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/bookmarks?select=tweet_id&offset=${offset}&limit=10000`,
      { headers }
    );
    if (!res.ok) throw new Error(`Failed to fetch bookmarks: ${res.status}`);
    const rows = await res.json();
    rows.forEach((r) => ids.add(r.tweet_id));
    if (rows.length < 10000) break;
    offset += 10000;
  }
  return ids;
}

function dataUrl(date, kind, index) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `https://ton.twimg.com/birdwatch-public-data/${y}/${m}/${d}/${kind}/${kind === "notes" ? "notes" : "noteStatusHistory"}-${String(index).padStart(5, "0")}.tsv`;
}

/** Streams a TSV URL line-by-line, calling onRow(columnsObject). Returns false on 404. */
async function streamTsv(url, onRow) {
  const res = await fetch(url);
  if (res.status === 404 || res.status === 403) return false;
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);

  const rl = createInterface({ input: Readable.fromWeb(res.body), crlfDelay: Infinity });
  let header = null;
  for await (const line of rl) {
    const cols = line.split("\t");
    if (!header) {
      header = cols;
      continue;
    }
    const row = {};
    header.forEach((h, i) => (row[h] = cols[i]));
    onRow(row);
  }
  return true;
}

/** Tries today's dataset, walking back up to 5 days (publication lags). */
async function streamAllFiles(kind, onRow) {
  for (let back = 0; back < 5; back++) {
    const date = new Date(Date.now() - back * 86400_000);
    let found = false;
    for (let index = 0; index < 50; index++) {
      const ok = await streamTsv(dataUrl(date, kind, index), onRow);
      if (!ok) break;
      found = true;
      console.log(`  processed ${dataUrl(date, kind, index)}`);
    }
    if (found) return true;
  }
  return false;
}

async function main() {
  console.log("Fetching bookmarked tweet IDs…");
  const tweetIds = await fetchBookmarkedTweetIds();
  console.log(`${tweetIds.size} bookmarked tweets to match against.`);
  if (tweetIds.size === 0) return;

  console.log("Streaming notes dataset…");
  const matches = new Map(); // noteId -> row
  const foundNotes = await streamAllFiles("notes", (row) => {
    if (tweetIds.has(row.tweetId)) matches.set(row.noteId, row);
  });
  if (!foundNotes) throw new Error("No notes dataset found in the last 5 days");
  console.log(`${matches.size} notes match bookmarked posts.`);
  if (matches.size === 0) return;

  console.log("Streaming note status history…");
  const statuses = new Map(); // noteId -> currentStatus
  await streamAllFiles("noteStatusHistory", (row) => {
    if (matches.has(row.noteId)) statuses.set(row.noteId, row.currentStatus);
  });

  const payload = [...matches.values()].map((row) => ({
    note_id: row.noteId,
    tweet_id: row.tweetId,
    note_text: row.summary ?? null,
    classification: row.classification ?? null,
    status: statuses.get(row.noteId) ?? "NEEDS_MORE_RATINGS",
    note_created_at: row.createdAtMillis
      ? new Date(Number(row.createdAtMillis)).toISOString()
      : null,
    fetched_at: new Date().toISOString(),
  }));

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/community_notes?on_conflict=note_id`,
    {
      method: "POST",
      headers: { ...headers, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify(payload),
    }
  );
  if (!res.ok) throw new Error(`Upsert failed: ${res.status} ${await res.text()}`);
  console.log(`Upserted ${payload.length} community notes.`);

  // Refresh credibility flags on analyses for affected tweets
  const misleadingTweets = new Set(
    payload
      .filter(
        (n) =>
          n.classification === "MISINFORMED_OR_POTENTIALLY_MISLEADING" &&
          n.status === "CURRENTLY_RATED_HELPFUL"
      )
      .map((n) => n.tweet_id)
  );
  const disputedTweets = new Set(
    payload.map((n) => n.tweet_id).filter((id) => !misleadingTweets.has(id))
  );

  for (const [credibility, set] of [
    ["misleading", misleadingTweets],
    ["disputed", disputedTweets],
  ]) {
    if (set.size === 0) continue;
    const idList = [...set].map((id) => `"${id}"`).join(",");
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/bookmark_analysis?tweet_id=in.(${idList})`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ credibility }),
      }
    );
    if (!res.ok) console.error(`Credibility update failed (${credibility}): ${res.status}`);
    else console.log(`Flagged ${set.size} analyses as ${credibility}.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
