/**
 * Server-side pipeline runner: sync → ingest → enrich, without the web UI.
 * Usage: NODE_OPTIONS="--conditions=react-server" npx tsx scripts/run-pipeline.ts [--reset]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Load .env.local (no dotenv dependency)
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

async function main() {
  const { db } = await import("../src/lib/supabase");
  const { syncUser } = await import("../src/lib/sync");
  const { ingestPending } = await import("../src/lib/ingest");
  const { enrichNewBookmarks } = await import("../src/lib/brain");

  const { data: users } = await db().from("users").select("id, handle").eq("is_allowed", true);
  if (!users?.length) throw new Error("No users in DB");

  for (const user of users) {
    console.log(`\n=== @${user.handle} ===`);

    if (process.argv.includes("--reset")) {
      console.log("Resetting bookmark data (analysis/sources cascade)…");
      const { error } = await db().from("bookmarks").delete().eq("user_id", user.id);
      if (error) throw new Error(error.message);
    }

    console.log("Syncing from X…");
    const sync = await syncUser(user.id);
    console.log(`  fetched=${sync.fetched} new=${sync.new} pendingAnalysis=${sync.pendingAnalysis}`);

    let round = 0;
    for (;;) {
      const ingest = await ingestPending(user.id, 15);
      const enrich = await enrichNewBookmarks(user.id, 60);
      const remaining = Math.max(ingest.remaining, enrich.remaining);
      console.log(
        `  round ${++round}: ingested=${ingest.ingested} enriched=${enrich.enriched} remaining=${remaining}`
      );
      if (remaining === 0) break;
      if (!ingest.ingested && !enrich.enriched) throw new Error("Pipeline stalled");
    }

    const { data: sourceStats } = await db()
      .from("bookmark_sources")
      .select("kind, status")
      .eq("user_id", user.id);
    const counts: Record<string, number> = {};
    for (const s of sourceStats ?? []) counts[`${s.kind}:${s.status}`] = (counts[`${s.kind}:${s.status}`] ?? 0) + 1;
    console.log("  sources:", JSON.stringify(counts));

    const { data: sample } = await db()
      .from("bookmark_sources")
      .select("kind, title, url, content")
      .eq("user_id", user.id)
      .eq("status", "ok")
      .eq("kind", "article")
      .limit(1);
    if (sample?.[0]) {
      console.log(`  sample article: "${sample[0].title}" — ${sample[0].content?.slice(0, 150)}…`);
    }
  }
  console.log("\nPipeline complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
