import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { FakeDb } from "./fake-db";
import { clearCapacityEnv, MB, prunedBrief, signedUrls, twoPeopleProject, withBucketMethods } from "./capacity-fixtures";

const state = vi.hoisted(() => ({ db: null as unknown, userId: "u1" as string | null }));
vi.mock("@/lib/session", () => ({ getSessionUserId: async () => state.userId }));
vi.mock("@/lib/supabase", () => ({ db: () => state.db }));

import { GET as capacityRoute } from "@/app/api/capacity/route";
import { POST as pruneRoute } from "@/app/api/capacity/prune/route";
import { GET as episodesRoute } from "@/app/api/episodes/route";

const LIMIT = 1000 * MB;
const DATABASE = { usedBytes: 14 * MB, limitBytes: 524_288_000, ratio: (14 * MB) / 524_288_000 };

let fake: FakeDb;

const prune = (body?: string) =>
  pruneRoute(new NextRequest("http://localhost/api/capacity/prune", { method: "POST", body }));
async function read(res: Response): Promise<{ status: number; json: Record<string, unknown> }> {
  return { status: res.status, json: await res.json() };
}
const row = (id: string) => fake.tables.episodes.find((r) => r.id === id) as Record<string, unknown>;
const removedPaths = () => fake.removals.flatMap((r) => r.paths);

beforeEach(() => {
  clearCapacityEnv({ STORAGE_LIMIT_BYTES: String(LIMIT), KEEP_RECENT_AUDIO: "2" });
  fake = twoPeopleProject(); // 1000 MB in use: u1's candidates a1, a2; u2's b1
  state.db = fake;
  state.userId = "u1";
  vi.spyOn(console, "error").mockImplementation(() => {}); // apiError logs every rejection
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("auth", () => {
  it("answers 401 without a session, before any work", async () => {
    state.userId = null;
    const responses = await Promise.all([capacityRoute(), prune(JSON.stringify({ dryRun: false }))]);
    expect(responses.map((res) => res.status)).toEqual([401, 401]);
    expect(fake.functions.storage_usage_bytes).not.toHaveBeenCalled();
    expect(fake.removals).toEqual([]);
  });
});

describe("GET /api/capacity", () => {
  it("answers with the capacity report", async () => {
    expect(await read(await capacityRoute())).toEqual({
      status: 200,
      json: {
        storage: { usedBytes: LIMIT, limitBytes: LIMIT, ratio: 1 },
        database: DATABASE,
        level: "critical",
        autoPrune: true,
        keepRecent: 2,
        recommendation:
          "Storage is almost full (100%). Oldest podcast audio is removed automatically before the next brief is saved (the newest 2 briefs per person are always kept).",
      },
    });
  });

  it("is a 500 when usage can't be measured", async () => {
    delete fake.functions.storage_usage_bytes;
    const { status, json } = await read(await capacityRoute());
    expect(status).toBe(500);
    expect(json.error).toMatch(/^Couldn't check storage capacity/);
  });
});

describe("POST /api/capacity/prune", () => {
  it("prunes only the session user's oldest audio, whatever the body says, then reports afresh", async () => {
    const { status, json } = await read(await prune(JSON.stringify({ userId: "u2" })));
    expect(status).toBe(200);
    expect(json).toEqual({
      pruned: [prunedBrief("a1"), prunedBrief("a2")],
      usedBytes: 800 * MB,
      capacity: expect.objectContaining({
        storage: { usedBytes: 800 * MB, limitBytes: LIMIT, ratio: 0.8 },
        level: "warn",
      }),
    });
    expect(removedPaths()).toEqual(["u1/a1/brief.mp3", "u1/a2/brief.mp3"]);
    expect(row("b1").audio_path).toBe("u2/b1/brief.mp3");
  });

  it("stops at the caller's own audio even while the instance is still over target", async () => {
    state.userId = "u2"; // one candidate (b1); b2 and b3 are kept
    expect((await read(await prune())).json).toMatchObject({
      pruned: [prunedBrief("b1")],
      usedBytes: 900 * MB,
      capacity: { level: "critical" },
    });
    expect(removedPaths()).toEqual(["u2/b1/brief.mp3"]);
  });

  it("with dryRun previews the same choice, estimated from durations, and touches nothing", async () => {
    const before = structuredClone(fake.tables);
    const { status, json } = await read(await prune(JSON.stringify({ dryRun: true })));
    expect(status).toBe(200);
    expect(json).toMatchObject({
      pruned: [prunedBrief("a1"), prunedBrief("a2")],
      usedBytes: LIMIT - 2 * 900 * 16_000, // two 900 s briefs at 128 kbps
      capacity: { storage: { usedBytes: LIMIT }, level: "critical" },
    });
    expect(fake.removals).toEqual([]);
    expect(fake.tables).toEqual(before);
  });

  it("without a body it really prunes; a malformed body is a 400 that deletes nothing", async () => {
    for (const body of ['{"dryRun": "yes"}', '{"dryRun": tru', "null", "[]"]) {
      const { status, json } = await read(await prune(body));
      expect(status, body).toBe(400);
      expect(json.error).toMatch(/^Expected a JSON body like \{"dryRun": true\}/);
    }
    expect(fake.removals).toEqual([]);

    expect((await prune()).status).toBe(200);
    expect(removedPaths()).toEqual(["u1/a1/brief.mp3", "u1/a2/brief.mp3"]);
  });

  it("is a 500 that keeps the row when a file can't be removed", async () => {
    state.db = withBucketMethods(fake, {
      remove: async () => ({ data: null, error: { message: "storage down" } }),
    });
    const { status, json } = await read(await prune());
    expect(status).toBe(500);
    expect(json.error).toMatch(/^Couldn't free up space/);
    expect(row("a1")).toMatchObject({ audio_path: "u1/a1/brief.mp3", audio_pruned_at: null });
  });
});

describe("GET /api/episodes after a prune", () => {
  it("hands audio_pruned_at to the client, with no audio_url", async () => {
    await prune(); // u1's a1 and a2
    state.db = withBucketMethods(fake, signedUrls);
    const { status, json } = await read(await episodesRoute());
    expect(status).toBe(200);
    const episodes = json.episodes as Record<string, unknown>[];
    expect(episodes.find((e) => e.id === "a1")).toMatchObject({
      audio_path: null,
      audio_url: null,
      audio_pruned_at: expect.any(String),
      markdown_url: "https://signed.test/u1/a1/brief.md",
    });
    expect(episodes.find((e) => e.id === "a3")).toMatchObject({
      audio_url: "https://signed.test/u1/a3/brief.mp3",
      audio_pruned_at: null,
    });
  });
});
