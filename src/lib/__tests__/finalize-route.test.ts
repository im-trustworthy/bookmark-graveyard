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
function project(otherBytes: number, more: { episodes?: Record<string, unknown>[]; files?: Record<string, number> } = {}) {
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
  });
}

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
