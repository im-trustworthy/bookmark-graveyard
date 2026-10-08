import { vi } from "vitest";
import { createFakeDb } from "./fake-db";
import type { FakeDb } from "./fake-db";

type Row = Record<string, unknown>;

/** Every env var src/lib/capacity.ts reads. */
export const CAPACITY_ENV_VARS = [
  "STORAGE_LIMIT_BYTES",
  "DATABASE_LIMIT_BYTES",
  "AUTO_PRUNE_AUDIO",
  "KEEP_RECENT_AUDIO",
] as const;
export type CapacityEnvVar = (typeof CAPACITY_ENV_VARS)[number];

/**
 * Deletes every capacity env var for the current test, whatever put it there
 * (a sourced .env.local, the developer's shell), then sets `vars`.
 * vi.unstubAllEnvs() in afterEach restores the originals.
 */
export function clearCapacityEnv(vars: Partial<Record<CapacityEnvVar, string>> = {}): void {
  for (const name of CAPACITY_ENV_VARS) vi.stubEnv(name, vars[name]);
}

export const MB = 1_000_000;

/** A finished markdown + podcast brief whose MP3 is at `<userId>/<id>/brief.mp3`. */
export function audioEpisode(id: string, userId: string, createdAt: string, extra: Row = {}): Row {
  return {
    id,
    user_id: userId,
    title: `Brief ${id}`,
    format: "both",
    status: "ready",
    created_at: createdAt,
    markdown_path: `${userId}/${id}/brief.md`,
    audio_path: `${userId}/${id}/brief.mp3`,
    duration_seconds: 900,
    audio_pruned_at: null,
    ...extra,
  };
}

/**
 * The fake db as a whole Supabase project: `episodes` rows, plus a
 * storage_usage_bytes() that sums `otherBytes` (markdown, chunks, …) and every
 * file in `files` not yet removed through storage.remove() (with p_user_id,
 * only that person's files, like the real function), and a
 * database_size_bytes() of `databaseBytes`.
 */
export function fakeProject({
  episodes,
  files = {},
  otherBytes = 0,
  databaseBytes = 14 * MB,
}: {
  episodes: Row[];
  files?: Record<string, number>;
  otherBytes?: number;
  databaseBytes?: number;
}): FakeDb {
  const fake = createFakeDb({ episodes });
  fake.functions.storage_usage_bytes = vi.fn((args: Record<string, unknown>) => {
    const removed = new Set(fake.removals.flatMap((r) => r.paths));
    const prefix = typeof args.p_user_id === "string" ? `${args.p_user_id}/` : null;
    let total = prefix ? 0 : otherBytes;
    for (const [path, bytes] of Object.entries(files)) {
      if (!removed.has(path) && (!prefix || path.startsWith(prefix))) total += bytes;
    }
    return total;
  });
  fake.functions.database_size_bytes = vi.fn(() => databaseBytes);
  return fake;
}

/**
 * `project` as a route sees it, its storage buckets extended with methods the
 * fake doesn't have (list, download, createSignedUrl, …). Tables, uploads,
 * removals and functions stay shared with `project`.
 */
export function withBucketMethods(project: FakeDb, methods: Record<string, unknown>) {
  return { ...project, storage: { from: (bucket: string) => ({ ...project.storage.from(bucket), ...methods }) } };
}

/** Signs every path as https://signed.test/<path>. */
export const signedUrls = {
  createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://signed.test/${path}` }, error: null }),
};

// Two people's finished briefs with audio, deliberately out of date order.
const BRIEFS = [
  ["a3", "u1", "2026-10-04T09:00:00.000Z"],
  ["b1", "u2", "2026-09-28T09:00:00.000Z"],
  ["a1", "u1", "2026-10-01T09:00:00.000Z"],
  ["b3", "u2", "2026-10-05T09:00:00.000Z"],
  ["a4", "u1", "2026-10-06T09:00:00.000Z"],
  ["b2", "u2", "2026-10-02T09:00:00.000Z"],
  ["a2", "u1", "2026-10-03T09:00:00.000Z"],
] as const;

/**
 * u1 has briefs a1 (Oct 1), a2 (Oct 3), a3 (Oct 4), a4 (Oct 6) and u2 has b1
 * (Sep 28), b2 (Oct 2), b3 (Oct 5), each with a 100 MB MP3; with the default
 * 300 MB of other files that's 1000 MB. Also seeded, never prunable: u1's
 * older markdown-only brief and a draft (with a stray audio_path), and u2's
 * brief whose audio is already gone. With KEEP_RECENT_AUDIO=2 the candidates,
 * oldest first, are b1, a1, a2.
 */
export function twoPeopleProject(otherBytes = 300 * MB): FakeDb {
  const briefs = BRIEFS.map(([id, userId, createdAt]) => audioEpisode(id, userId, createdAt));
  return fakeProject({
    episodes: [
      ...briefs,
      audioEpisode("md", "u1", "2026-09-01T09:00:00.000Z", {
        format: "markdown",
        audio_path: null,
        duration_seconds: null,
      }),
      audioEpisode("draft", "u1", "2026-09-02T09:00:00.000Z", { status: "draft" }),
      audioEpisode("gone", "u2", "2026-09-03T09:00:00.000Z", {
        audio_path: null,
        audio_pruned_at: "2026-09-20T09:00:00.000Z",
      }),
    ],
    files: Object.fromEntries(briefs.map((brief) => [brief.audio_path as string, 100 * MB])),
    otherBytes,
  });
}

/** How pruneAudio() reports one of twoPeopleProject's briefs. */
export function prunedBrief(id: string) {
  const brief = BRIEFS.find(([briefId]) => briefId === id);
  if (!brief) throw new Error(`no brief ${id}`);
  const [, userId, createdAt] = brief;
  return { episodeId: id, userId, title: `Brief ${id}`, createdAt };
}
