import { db } from "./supabase";

export async function signEpisodeUrls(episode: {
  markdown_path: string | null;
  audio_path: string | null;
  [k: string]: unknown;
}) {
  const storage = db().storage.from("episodes");
  const sign = async (path: string | null) =>
    path ? (await storage.createSignedUrl(path, 60 * 60 * 24)).data?.signedUrl ?? null : null;
  return {
    ...episode,
    markdown_url: await sign(episode.markdown_path),
    audio_url: await sign(episode.audio_path),
  };
}
