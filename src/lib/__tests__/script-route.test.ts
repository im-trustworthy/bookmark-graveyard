import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createFakeDb } from "./fake-db";
import type { FakeDb } from "./fake-db";
import { withBucketMethods } from "./capacity-fixtures";

// The script route's error contract: a stage refusal keeps the exact status and body the route returned
// before the stages moved into src/lib/digest.ts. Session, storage and the paid Grok call are mocked, so
// "no paid work happened" is observable.
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/session", () => ({ getSessionUserId: async () => "user-1" }));
vi.mock("@/lib/supabase", () => ({ db: () => state.db }));
vi.mock("@/lib/limits", () => ({ checkUsage: vi.fn(), UsageLimitError: class UsageLimitError extends Error {} }));
vi.mock("@/lib/brain", () => ({ writePodcastScript: vi.fn() }));

import { POST } from "@/app/api/digest/script/route";
import { writePodcastScript } from "@/lib/brain";
import type { ScriptLine } from "@/lib/brain";
import { DigestStageError, scriptBrief } from "@/lib/digest";
import { checkUsage } from "@/lib/limits";

async function script(): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await POST(
    new NextRequest("http://localhost/api/digest/script", {
      method: "POST",
      body: JSON.stringify({ episodeId: "ep-1", targetMinutes: 10 }),
    })
  );
  return { status: res.status, json: await res.json() };
}

function withEpisodes(episodes: Record<string, unknown>[]) {
  state.db = createFakeDb({ episodes });
}
const episode = (status: string) => ({
  id: "ep-1",
  user_id: "user-1",
  status,
  markdown_path: "user-1/2026-10-07-12-00/brief.md",
});

let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/digest/script stage errors", () => {
  it("answers a finished episode with a logged 409 and does no paid work", async () => {
    withEpisodes([episode("ready")]);

    // Outside production the underlying detail rides along, as it does for every apiError response.
    expect(await script()).toEqual({ status: 409, json: { error: "Episode is not resumable — episode not draft" } });
    expect(errorLog).toHaveBeenCalledWith("Digest script error:", "episode not draft");
    expect(checkUsage).not.toHaveBeenCalled();
    expect(writePodcastScript).not.toHaveBeenCalled();
  });

  it("keeps the detail out of the response in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    withEpisodes([episode("ready")]);

    expect(await script()).toEqual({ status: 409, json: { error: "Episode is not resumable" } });
    expect(errorLog).toHaveBeenCalledWith("Digest script error:", "episode not draft");
  });

  it("gets the refusal from the library as a DigestStageError the route only maps", async () => {
    withEpisodes([episode("ready")]);

    const refusal = await scriptBrief("user-1", "ep-1", 10).catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(DigestStageError);
    expect(refusal).toMatchObject({ status: 409, publicMessage: "Episode is not resumable", logDetail: "episode not draft" });
    expect(errorLog).not.toHaveBeenCalled(); // logging is the route's job
    expect(checkUsage).not.toHaveBeenCalled();
  });

  it("answers a missing episode with a bare, unlogged 404", async () => {
    withEpisodes([]);

    expect(await script()).toEqual({ status: 404, json: { error: "Episode not found" } });
    expect(errorLog).not.toHaveBeenCalled();
    expect(checkUsage).not.toHaveBeenCalled();
  });
});

describe("POST /api/digest/script is write-once", () => {
  const lines = (n: number, tag: string): ScriptLine[] =>
    Array.from({ length: n }, (_, i) => ({ speaker: "A", line: `${tag} ${i}` }));
  let fake: FakeDb;
  let downloads: string[];

  /** The draft, with a markdown file the stage can download. */
  function project(row: Record<string, unknown> = {}) {
    fake = createFakeDb({ episodes: [{ ...episode("draft"), ...row }] });
    downloads = [];
    state.db = withBucketMethods(fake, {
      download: async (path: string) => {
        downloads.push(path);
        return { data: new Blob(["# Brief"]), error: null };
      },
    });
  }
  const row = () => fake.tables.episodes[0];

  it("writes the script on a draft that has none", async () => {
    project({ script: null });
    vi.mocked(writePodcastScript).mockResolvedValueOnce(lines(5, "ours"));

    expect(await script()).toEqual({ status: 200, json: { totalLines: 5 } });
    expect(checkUsage).toHaveBeenCalledWith("user-1", "digest_script");
    expect(row().script).toEqual(lines(5, "ours"));
  });

  it("a draft that already has its script answers with it and spends nothing", async () => {
    project({ script: lines(7, "first") });

    expect(await script()).toEqual({ status: 200, json: { totalLines: 7 } });
    expect(downloads).toEqual([]);
    expect(checkUsage).not.toHaveBeenCalled();
    expect(writePodcastScript).not.toHaveBeenCalled();
    expect(row().script).toEqual(lines(7, "first"));
  });

  it("losing the race to another writer keeps the winner's script and returns its length", async () => {
    project({ script: null });
    vi.mocked(writePodcastScript).mockImplementationOnce(async () => {
      row().script = lines(3, "winner"); // another tab saved while this call was generating
      return lines(5, "loser");
    });

    expect(await script()).toEqual({ status: 200, json: { totalLines: 3 } });
    expect(row().script).toEqual(lines(3, "winner"));
  });

  it("an episode discarded while generating is a 404, and nothing is written", async () => {
    project({ script: null });
    vi.mocked(writePodcastScript).mockImplementationOnce(async () => {
      fake.tables.episodes = [];
      return lines(5, "ours");
    });

    expect(await script()).toEqual({ status: 404, json: { error: "Episode not found" } });
    expect(fake.tables.episodes).toEqual([]);
  });

  it("an episode that stopped being a draft while generating is the usual 409, and is not overwritten", async () => {
    project({ script: null });
    vi.mocked(writePodcastScript).mockImplementationOnce(async () => {
      row().status = "failed";
      return lines(5, "ours");
    });

    expect(await script()).toEqual({ status: 409, json: { error: "Episode is not resumable — episode not draft" } });
    expect(row().script).toBeNull();
  });
});
