import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { FakeDb } from "./fake-db";
import { audioEpisode, clearCapacityEnv, fakeProject, signedUrls, withBucketMethods } from "./capacity-fixtures";
import { audioFrame } from "./mp3-fixtures";

// Only the capacity guard in front of the brief.mp3 upload is under test:
// storage is the fake's plus a stub listing one rendered chunk.
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/session", () => ({ getSessionUserId: async () => "u1" }));
vi.mock("@/lib/supabase", () => ({ db: () => state.db }));

import { POST } from "@/app/api/digest/finalize/route";

// One rendered chunk of two CBR frames, so the stitched brief.mp3 is exactly these bytes.
const CHUNK = Buffer.concat([audioFrame(1), audioFrame(2)]);
const LIMIT = 10_000; // critical from 9000 bytes

let fake: FakeDb;

/** u1's draft, rendered and ready to stitch, in storage holding `otherBytes` plus `files`. */
function project(
  otherBytes: number,
  more: { episodes?: Record<string, unknown>[]; files?: Record<string, number> } = {},
  methods: Record<string, unknown> = {}
) {
  const draft = {
    id: "ep-new",
    user_id: "u1",
    title: "This week",
    format: "both",
    status: "draft",
    created_at: "2026-10-07T12:00:00.000Z",
    script: [
      { speaker: "A", line: "One." },
      { speaker: "B", line: "Two." },
    ],
    markdown_path: "u1/new/brief.md",
    audio_path: null,
    duration_seconds: null,
    audio_pruned_at: null,
  };
  fake = fakeProject({ episodes: [draft, ...(more.episodes ?? [])], files: more.files, otherBytes });
  state.db = withBucketMethods(fake, {
    ...signedUrls,
    list: async (prefix: string) => ({ data: prefix === "u1/new/chunks" ? [{ name: "00000.mp3" }] : [], error: null }),
    download: async () => ({ data: new Blob([new Uint8Array(CHUNK)]), error: null }),
    ...methods,
  });
}

/** Makes the next update of an episode row fail with `message`, as a dropped connection would. */
function failNextEpisodeUpdate(message: string) {
  const routeDb = state.db as { from: (table: string) => unknown };
  const realFrom = routeDb.from;
  const failed: unknown = new Proxy(
    {},
    {
      get: (_target, prop) =>
        prop === "then"
          ? (resolve: (r: unknown) => unknown) => resolve({ data: null, error: { message } })
          : () => failed,
    }
  );
  let armed = true;
  routeDb.from = (table: string) => {
    const query = realFrom(table) as { update: (patch: unknown) => unknown };
    if (table === "episodes" && armed) {
      query.update = () => {
        armed = false;
        return failed;
      };
    }
    return query;
  };
}

const CHUNK_PATH = "u1/new/chunks/00000.mp3";

async function finalize(): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await POST(
    new NextRequest("http://localhost/api/digest/finalize", {
      method: "POST",
      body: JSON.stringify({ episodeId: "ep-new" }),
    })
  );
  return { status: res.status, json: await res.json() };
}
const row = (id: string) => fake.tables.episodes.find((r) => r.id === id);

beforeEach(() => {
  clearCapacityEnv({ STORAGE_LIMIT_BYTES: String(LIMIT), AUTO_PRUNE_AUDIO: "off" });
  vi.spyOn(console, "error").mockImplementation(() => {}); // apiError logs every rejection
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/digest/finalize capacity guard", () => {
  it("counts exactly the stitched file: landing on 90% still publishes", async () => {
    project(9000 - CHUNK.length);
    const { status, json } = await finalize();
    expect(status).toBe(200);
    expect(json.episode).toMatchObject({
      status: "ready",
      audio_path: "u1/new/brief.mp3",
      audio_url: "https://signed.test/u1/new/brief.mp3",
    });
    expect(fake.uploads).toEqual([{ bucket: "episodes", path: "u1/new/brief.mp3" }]);
  });

  it("one byte more is a 507 with the reason: nothing uploaded, chunks kept, still a resumable draft", async () => {
    project(9000 - CHUNK.length + 1);
    expect(await finalize()).toEqual({
      status: 507,
      json: {
        error:
          "Storage is 82% full, too full for this brief's audio — remove old podcast audio under Previous briefs, or raise STORAGE_LIMIT_BYTES",
      },
    });
    expect(fake.uploads).toEqual([]);
    expect(fake.removals).toEqual([]);
    expect(row("ep-new")).toMatchObject({ status: "draft", audio_path: null });
  });

  it("with auto-prune on, removes someone else's oldest audio to make room, then publishes", async () => {
    vi.stubEnv("AUTO_PRUNE_AUDIO", undefined);
    vi.stubEnv("KEEP_RECENT_AUDIO", "0");
    project(7000, {
      episodes: [audioEpisode("old", "u2", "2026-09-01T09:00:00.000Z")],
      files: { "u2/old/brief.mp3": 2000 },
    }); // 9000 bytes in use
    expect((await finalize()).status).toBe(200);
    expect(fake.removals.map((r) => r.paths)).toEqual([["u2/old/brief.mp3"], ["u1/new/chunks/00000.mp3"]]);
    expect(row("old")).toMatchObject({ audio_path: null, audio_pruned_at: expect.any(String) });
    expect(fake.uploads).toEqual([{ bucket: "episodes", path: "u1/new/brief.mp3" }]);
  });
});

describe("POST /api/digest/finalize publishes before it cleans up", () => {
  it("removes the chunks only after the row is ready", async () => {
    project(0, {}, {
      remove: async (paths: string[]) => {
        expect(row("ep-new")?.status).toBe("ready"); // the row is published before any chunk goes
        fake.removals.push({ bucket: "episodes", paths });
        return { data: [], error: null };
      },
    });
    expect((await finalize()).status).toBe(200);
    expect(fake.removals).toEqual([{ bucket: "episodes", paths: [CHUNK_PATH] }]);
  });

  it("a failed row update leaves the chunks in storage, and a retry publishes", async () => {
    project(0);
    failNextEpisodeUpdate("connection reset");

    const first = await finalize();
    expect(first.status).toBe(500);
    expect(first.json.error).toMatch(/^Finalize failed/);
    expect(fake.removals).toEqual([]); // the chunks are still there to stitch from
    expect(row("ep-new")).toMatchObject({ status: "draft", audio_path: null });

    const retry = await finalize();
    expect(retry.status).toBe(200);
    expect(retry.json.episode).toMatchObject({ status: "ready", audio_path: "u1/new/brief.mp3" });
    expect(fake.removals).toEqual([{ bucket: "episodes", paths: [CHUNK_PATH] }]);
  });

  it("a chunk-cleanup failure is logged, not thrown: the brief is published", async () => {
    project(0, {}, { remove: async () => ({ data: null, error: { message: "storage down" } }) });
    const { status, json } = await finalize();
    expect(status).toBe(200);
    expect(json.episode).toMatchObject({ status: "ready" });
    expect(console.error).toHaveBeenCalledWith("finalizeBrief: chunk cleanup failed:", { message: "storage down" });
  });
});

describe("POST /api/digest/finalize races", () => {
  /** Another finalize publishing the episode while this one is stitching. */
  const publishedElsewhere = () =>
    Object.assign(row("ep-new")!, { status: "ready", audio_path: "u1/new/brief.mp3", duration_seconds: 1 });

  it("losing to a concurrent finalize returns the ready episode and leaves its audio and chunks alone", async () => {
    project(0, {}, {
      upload: async (path: string) => {
        fake.uploads.push({ bucket: "episodes", path });
        publishedElsewhere();
        return { error: null };
      },
    });
    const { status, json } = await finalize();
    expect(status).toBe(200);
    expect(json.episode).toMatchObject({
      status: "ready",
      audio_path: "u1/new/brief.mp3",
      duration_seconds: 1, // the winner's row, not overwritten
      audio_url: "https://signed.test/u1/new/brief.mp3",
    });
    expect(fake.removals).toEqual([]);
  });

  it("a chunk the winner already removed is not an error once the episode is ready", async () => {
    project(0, {}, {
      download: async () => {
        publishedElsewhere();
        return { data: null, error: { message: "Object not found" } };
      },
    });
    const { status, json } = await finalize();
    expect(status).toBe(200);
    expect(json.episode).toMatchObject({ status: "ready", audio_path: "u1/new/brief.mp3" });
    expect(fake.uploads).toEqual([]);
  });

  it("an empty chunk listing is not an error once the winner published and cleaned up", async () => {
    project(0, {}, {
      list: async () => {
        publishedElsewhere(); // a draft at this call's first read, ready with its chunks gone by the listing
        return { data: [], error: null };
      },
    });
    const { status, json } = await finalize();
    expect(status).toBe(200);
    expect(json.episode).toMatchObject({ status: "ready", audio_path: "u1/new/brief.mp3", duration_seconds: 1 });
    expect(fake.uploads).toEqual([]);
  });

  it("an empty chunk listing on a draft is still a 400", async () => {
    project(0, {}, { list: async () => ({ data: [], error: null }) });
    expect(await finalize()).toEqual({ status: 400, json: { error: "No rendered audio chunks found" } });
    expect(row("ep-new")).toMatchObject({ status: "draft" });
  });

  it("a missing chunk on a draft still fails as before", async () => {
    project(0, {}, { download: async () => ({ data: null, error: { message: "Object not found" } }) });
    const { status, json } = await finalize();
    expect(status).toBe(500);
    expect(json.error).toMatch(/^Finalize failed/);
    expect(row("ep-new")).toMatchObject({ status: "draft" });
  });

  it("discarded while stitching: a 404, and the audio it just uploaded is removed", async () => {
    project(0, {}, {
      upload: async (path: string) => {
        fake.uploads.push({ bucket: "episodes", path });
        fake.tables.episodes = fake.tables.episodes.filter((r) => r.id !== "ep-new");
        return { error: null };
      },
    });
    expect(await finalize()).toEqual({ status: 404, json: { error: "Episode not found" } });
    expect(fake.removals).toEqual([{ bucket: "episodes", paths: ["u1/new/brief.mp3"] }]);
  });
});
