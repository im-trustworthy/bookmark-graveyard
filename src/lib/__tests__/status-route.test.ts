import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createFakeDb } from "./fake-db";
import type { FakeDb } from "./fake-db";
import { withBucketMethods } from "./capacity-fixtures";

// The status route's resume report and its discard. Session and storage are the fake's, plus a chunk
// listing per folder, so which files went (and when) is observable.
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/session", () => ({ getSessionUserId: async () => "u1" }));
vi.mock("@/lib/supabase", () => ({ db: () => state.db }));

import { DELETE, GET } from "@/app/api/digest/status/route";

const lines = (n: number) => Array.from({ length: n }, (_, i) => ({ speaker: "A", line: `Line ${i}.` }));

let fake: FakeDb;
let listings: string[];
/** Episode rows still present each time storage was listed, to see what was deleted first. */
let rowsAtListing: number[];

function project(episodes: Record<string, unknown>[], chunks: Record<string, string[]> = {}) {
  fake = createFakeDb({ episodes });
  listings = [];
  rowsAtListing = [];
  state.db = withBucketMethods(fake, {
    list: async (prefix: string) => {
      listings.push(prefix);
      rowsAtListing.push(fake.tables.episodes.length);
      return { data: (chunks[prefix] ?? []).map((name) => ({ name })), error: null };
    },
  });
}

function draft(extra: Record<string, unknown> = {}) {
  return {
    id: "ep-1",
    user_id: "u1",
    title: "This week",
    status: "draft",
    script: null,
    markdown_path: "u1/ep-1/brief.md",
    audio_path: null,
    created_at: "2026-10-07T12:00:00.000Z",
    ...extra,
  };
}

async function discard(episodeId = "ep-1") {
  const res = await DELETE(
    new NextRequest(`http://localhost/api/digest/status?episodeId=${episodeId}`, { method: "DELETE" })
  );
  return { status: res.status, json: await res.json() };
}

async function status(episodeId?: string) {
  const query = episodeId ? `?episodeId=${episodeId}` : "";
  const res = await GET(new NextRequest(`http://localhost/api/digest/status${query}`));
  return { status: res.status, json: await res.json() };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("DELETE /api/digest/status (discard)", () => {
  it("deletes a draft's row first, then its files", async () => {
    project([draft({ script: lines(30) })], { "u1/ep-1/chunks": ["00000.mp3", "00012.mp3"] });

    expect(await discard()).toEqual({ status: 200, json: { deleted: true } });
    expect(fake.tables.episodes).toEqual([]);
    expect(rowsAtListing).toEqual([0]); // the folder was listed only once the row was gone
    expect(fake.removals).toEqual([
      {
        bucket: "episodes",
        paths: ["u1/ep-1/brief.md", "u1/ep-1/chunks/00000.mp3", "u1/ep-1/chunks/00012.mp3"],
      },
    ]);
  });

  it("refuses a ready episode with the same 400, deleting nothing: row and files intact", async () => {
    const ready = draft({ status: "ready", audio_path: "u1/ep-1/brief.mp3" });
    project([ready]);

    expect(await discard()).toEqual({ status: 400, json: { error: "Only draft episodes can be discarded" } });
    expect(fake.tables.episodes).toEqual([ready]);
    expect(listings).toEqual([]);
    expect(fake.removals).toEqual([]);
  });

  it("answers a missing episode with the same 404", async () => {
    project([draft()]);

    expect(await discard("ep-other")).toEqual({ status: 404, json: { error: "Episode not found" } });
    expect(fake.tables.episodes).toHaveLength(1);
    expect(fake.removals).toEqual([]);
  });

  it("leaves someone else's draft alone", async () => {
    project([draft({ user_id: "u2" })]);

    expect(await discard()).toEqual({ status: 404, json: { error: "Episode not found" } });
    expect(fake.tables.episodes).toHaveLength(1);
    expect(fake.removals).toEqual([]);
  });
});

describe("GET /api/digest/status (resume point)", () => {
  it("reports where a half-rendered draft resumes, from its chunk files", async () => {
    project([draft({ script: lines(30) })], { "u1/ep-1/chunks": ["00000.mp3", "00012.mp3"] });

    expect(await status()).toEqual({
      status: 200,
      json: {
        episodeId: "ep-1",
        stage: "rendering",
        totalLines: 30,
        nextCursor: 12,
        markdownReady: true,
        title: "This week",
        createdAt: "2026-10-07T12:00:00.000Z",
      },
    });
  });

  it("does not list storage for a draft with no script, or a ready episode", async () => {
    project([draft(), draft({ id: "ep-2", status: "ready", script: lines(30) })]);

    expect((await status("ep-1")).json).toMatchObject({ stage: "needs_script", totalLines: 0, nextCursor: 0 });
    expect((await status("ep-2")).json).toMatchObject({ stage: "ready", totalLines: 30, nextCursor: 30 });
    expect(listings).toEqual([]);
  });

  it("with no draft to resume, reports none", async () => {
    project([draft({ status: "ready" })]);

    expect((await status()).json).toEqual({
      episodeId: null,
      stage: "none",
      totalLines: 0,
      nextCursor: 0,
      markdownReady: false,
    });
  });
});
