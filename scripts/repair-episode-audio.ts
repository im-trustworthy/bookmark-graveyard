/**
 * One-off repair for podcast files rendered before src/lib/mp3.ts existed.
 *
 * Those files are byte-concatenations of per-line ElevenLabs clips, each with
 * its own ID3 tag and Xing/Info header frame, which breaks seeking in Safari
 * and iOS. For every episode with audio this strips the stray headers,
 * re-uploads the cleaned file over the original, and stores the real duration.
 *
 * Usage:
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npx tsx scripts/repair-episode-audio.ts [--dry-run]
 */
import { createClient } from "@supabase/supabase-js";
import { mp3DurationSeconds, stripMp3Headers } from "../src/lib/mp3";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const dryRun = process.argv.includes("--dry-run");
const db = createClient(url, key, { auth: { persistSession: false } });

async function main() {
  const { data: episodes, error } = await db
    .from("episodes")
    .select("id, title, audio_path, duration_seconds")
    .not("audio_path", "is", null);
  if (error) throw new Error(error.message);

  for (const ep of episodes ?? []) {
    const { data, error: dlErr } = await db.storage.from("episodes").download(ep.audio_path);
    if (dlErr || !data) {
      console.error(`${ep.title}: download failed: ${dlErr?.message}`);
      continue;
    }
    const original = Buffer.from(await data.arrayBuffer());
    const cleaned = stripMp3Headers(original);
    const seconds = Math.round(mp3DurationSeconds(cleaned));
    const changed = cleaned.length !== original.length;
    console.log(
      `${ep.title}  (${ep.audio_path})\n` +
        `   bytes ${original.length} -> ${cleaned.length}${changed ? "" : " (already clean)"}; ` +
        `duration ${ep.duration_seconds ?? "?"}s -> ${seconds}s`
    );
    if (dryRun) continue;

    if (changed) {
      const { error: upErr } = await db.storage
        .from("episodes")
        .upload(ep.audio_path, cleaned, { contentType: "audio/mpeg", upsert: true });
      if (upErr) throw new Error(`${ep.title}: upload failed: ${upErr.message}`);
    }
    if (seconds > 0 && seconds !== ep.duration_seconds) {
      const { error: updErr } = await db.from("episodes").update({ duration_seconds: seconds }).eq("id", ep.id);
      if (updErr) throw new Error(`${ep.title}: duration update failed: ${updErr.message}`);
    }
    console.log(`   ${changed ? "re-uploaded" : "file untouched"}; duration ${seconds !== ep.duration_seconds ? "updated" : "unchanged"}.`);
  }
  if (dryRun) console.log("(dry run: nothing written)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
