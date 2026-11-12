import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createFakeDb } from "./fake-db";
import type { FakeDb } from "./fake-db";
import { expectConformance, MoveLog } from "./conformance";
import type { NotExercised } from "./conformance";
import { clearCapacityEnv } from "./capacity-fixtures";
import { audioFrame } from "./mp3-fixtures";
import { clearVoiceEnv } from "./voice-env";

// The digest stages against their table. Every stage function (prepare, script, render, finalize) and the
// discard handler runs for real against the fake database and a fake storage that keeps the bytes it is
// given; resumePointFor reads the stage from the stored row and the chunk files after each step, and each
// step that changed what is stored is held against DIGEST_STAGE_TRANSITIONS. Only the paid or external
// edges are replaced: the selection and writing passes, the script writer, the usage cap, and the voice
// vendor's HTTP endpoint (the real TTS code runs against it).
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/session", () => ({ getSessionUserId: async () => "u1" }));
vi.mock("@/lib/supabase", () => ({ db: () => state.db }));
vi.mock("@/lib/limits", () => ({ checkUsage: vi.fn(), UsageLimitError: class UsageLimitError extends Error {} }));
vi.mock("@/lib/brain", () => ({
  selectBookmarksForDigest: vi.fn(),
  stalenessPass: vi.fn(),
  writeMarkdownDigest: vi.fn(),
  writePodcastScript: vi.fn(),
}));

import { DELETE } from "@/app/api/digest/status/route";
import { selectBookmarksForDigest, stalenessPass, writeMarkdownDigest, writePodcastScript } from "@/lib/brain";
import type { ScriptLine } from "@/lib/brain";
import { DigestStageError, finalizeBrief, prepareBrief, renderChunk, scriptBrief } from "@/lib/digest";
import { resumePointFor } from "@/lib/episodes";
import { canMoveDigestStage, DIGEST_STAGE_TRANSITIONS, LINES_PER_CALL, scriptLengthOf } from "@/lib/state/episode";
import type { DigestStage } from "@/lib/state/episode";

const lines = (n: number): ScriptLine[] => Array.from({ length: n }, (_, i) => ({ speaker: i % 2 ? "B" : "A", line: `Line ${i}.` }));

const moves = new MoveLog<DigestStage>();
let fake: FakeDb;
/** Every file in storage, by path, with the bytes uploaded. */
let files: Map<string, Buffer>;
/** The episode the scenario drives; unset until prepare has saved it. */
let episodeId: string | undefined;

/** The fake's storage plus what the stages read back: it keeps uploaded bytes, lists a folder, signs URLs. */
function storage() {
  const base = fake.storage.from("episodes");
  return {
    upload: async (path: string, body: Buffer | Uint8Array) => {
      files.set(path, Buffer.from(body));
      return base.upload(path);
    },
    remove: async (paths: string[]) => {
      for (const path of paths) files.delete(path);
      return base.remove(paths);
    },
    list: async (prefix: string) => ({
      data: [...files.keys()]
        .filter((path) => path.startsWith(`${prefix}/`) && !path.slice(prefix.length + 1).includes("/"))
        .sort()
        .map((path) => ({ name: path.slice(prefix.length + 1) })),
      error: null,
    }),
    download: async (path: string) => {
      const bytes = files.get(path);
      return bytes ? { data: new Blob([new Uint8Array(bytes)]), error: null } : { data: null, error: { message: "not found" } };
    },
    createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://signed.test/${path}` }, error: null }),
  };
}

/** What is stored for the episode: its derived stage, and a fingerprint of everything a stage writes. */
async function snapshot(): Promise<{ stage: DigestStage; fingerprint: string }> {
  const row = fake.tables.episodes.find((r) => r.id === episodeId);
  if (!row) return { stage: "none", fingerprint: "no row" };
  const { stage } = await resumePointFor(row as { status: string; script: unknown; markdown_path: string | null });
  const fingerprint = JSON.stringify([row.status, scriptLengthOf(row.script), row.render_cursor, row.audio_path, [...files.keys()].sort()]);
  return { stage, fingerprint };
}

/**
 * Runs one stage call and records the move it made, if it changed anything stored. A step that left the
 * stored state alone (an idempotent replay, a refusal) is no move, whatever stage it read the same twice.
 */
async function step<T>(call: () => Promise<T>): Promise<T> {
  const before = await snapshot();
  const result = await call();
  const after = await snapshot();
  if (before.fingerprint !== after.fingerprint) moves.record(before.stage, after.stage);
  return result;
}

const refusal = (call: () => Promise<unknown>) => call().then(() => null, (err: unknown) => err);

// The stages, as a scenario calls them.
async function prepare(format: "markdown" | "both") {
  const prepared = await step(async () => {
    const result = await prepareBrief("u1", { format });
    episodeId = (result.episode as unknown as { id: string }).id;
    // The columns the database defaults and the fake does not.
    const row = fake.tables.episodes.find((r) => r.id === episodeId)!;
    row.render_cursor ??= 0;
    row.script ??= null;
    return result;
  });
  return prepared;
}
const script = (n: number) => {
  vi.mocked(writePodcastScript).mockResolvedValueOnce(lines(n));
  return step(() => scriptBrief("u1", episodeId!, 15));
};
const render = (cursor: number) => step(() => renderChunk("u1", episodeId!, cursor));
const finalize = () => step(() => finalizeBrief("u1", episodeId!));
async function discard() {
  return step(async () => {
    const res = await DELETE(new NextRequest(`http://localhost/api/digest/status?episodeId=${episodeId}`, { method: "DELETE" }));
    return { status: res.status, json: await res.json() };
  });
}

/** Renders every chunk the way the dashboard's loop does: from the resume cursor, then each returned cursor. Returns how many calls it took. */
async function renderToEnd(): Promise<number> {
  const row = fake.tables.episodes.find((r) => r.id === episodeId)!;
  let { nextCursor: cursor } = await resumePointFor(row as { status: string; script: unknown; markdown_path: string | null });
  for (let calls = 1; ; calls++) {
    const result = await render(cursor);
    if (result.done) return calls;
    cursor = result.nextCursor;
  }
}

beforeEach(() => {
  fake = createFakeDb({ episodes: [], user_voice_settings: [] });
  fake.functions.storage_usage_bytes = () => 0;
  fake.functions.database_size_bytes = () => 0;
  files = new Map();
  episodeId = undefined;
  const bucket = storage();
  state.db = { ...fake, storage: { from: () => bucket } };

  clearVoiceEnv({ XAI_API_KEY: "xai-instance-key" });
  clearCapacityEnv({ STORAGE_LIMIT_BYTES: "1000000000", AUTO_PRUNE_AUDIO: "off" });
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async () => new Response(new Uint8Array(audioFrame(1)), { headers: { "Content-Type": "audio/mpeg" } }))
  );
  vi.mocked(selectBookmarksForDigest).mockResolvedValue({
    included: [{ tweet_id: "1" }],
    excludedAsMisleading: [],
  } as unknown as Awaited<ReturnType<typeof selectBookmarksForDigest>>);
  vi.mocked(writePodcastScript).mockReset();
  vi.mocked(stalenessPass).mockResolvedValue(new Map());
  vi.mocked(writeMarkdownDigest).mockResolvedValue("# Brief");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("digest stage conformance", () => {
  it("a markdown-only brief goes from none to ready in prepare, and nothing moves it after", async () => {
    expect((await snapshot()).stage).toBe("none");
    const prepared = await prepare("markdown");
    expect(prepared.done).toBe(true);
    expect((await snapshot()).stage).toBe("ready");

    // Every later call is a replay or a refusal: stored state stays, so no move is recorded.
    const replayed = await finalize();
    expect(replayed.episode).toMatchObject({ id: episodeId, status: "ready" });
    expect(await refusal(() => step(() => scriptBrief("u1", episodeId!, 15)))).toBeInstanceOf(DigestStageError);
    expect(await refusal(() => render(0))).toBeInstanceOf(DigestStageError);
    expect(await discard()).toMatchObject({ status: 400 });
    expect((await snapshot()).stage).toBe("ready");
  });

  it("a podcast that fits one chunk: none, needs_script, rendering, needs_finalize, ready", async () => {
    await prepare("both");
    expect((await snapshot()).stage).toBe("needs_script");
    await script(5);
    expect((await snapshot()).stage).toBe("rendering");
    expect(await render(0)).toEqual({ nextCursor: 5, totalLines: 5, done: true });
    expect((await snapshot()).stage).toBe("needs_finalize");
    await finalize();
    expect((await snapshot()).stage).toBe("ready");
    // The chunks are gone and the brief stays ready: a finalize replay moves nothing.
    await finalize();
    expect((await snapshot()).stage).toBe("ready");
  });

  it("a script longer than one chunk stays rendering until the last chunk lands", async () => {
    await prepare("both");
    await script(2 * LINES_PER_CALL + 6);
    // A script call replayed on the same draft answers with the stored script and writes nothing.
    await step(() => scriptBrief("u1", episodeId!, 15));
    expect(writePodcastScript).toHaveBeenCalledTimes(1);
    expect(scriptLengthOf(fake.tables.episodes[0].script)).toBe(2 * LINES_PER_CALL + 6);

    expect(await renderToEnd()).toBe(3);
    expect((await snapshot()).stage).toBe("needs_finalize");

    // Re-rendering the last chunk (the resume rule's redo) rewrites what is there: no move.
    await render(2 * LINES_PER_CALL);
    expect((await snapshot()).stage).toBe("needs_finalize");

    await finalize();
    expect((await snapshot()).stage).toBe("ready");
  });

  it.each([
    ["needs_script", async () => {}],
    [
      "rendering",
      async () => {
        await script(30);
        await render(0);
      },
    ],
    [
      "needs_finalize",
      async () => {
        await script(5);
        await render(0);
      },
    ],
  ] as const)("discarding a draft in %s leaves no row and no files", async (stage, advance) => {
    await prepare("both");
    await advance();
    expect((await snapshot()).stage).toBe(stage);

    expect(await discard()).toEqual({ status: 200, json: { deleted: true } });
    expect((await snapshot()).stage).toBe("none");
    expect(fake.tables.episodes).toEqual([]);
    expect([...files.keys()]).toEqual([]);
  });

  it("a discarded draft answers not found to every stage and moves nothing", async () => {
    await prepare("both");
    await discard();
    expect(await refusal(() => script(5))).toMatchObject({ status: 404 });
    expect(await refusal(() => render(0))).toMatchObject({ status: 404 });
    expect(await refusal(() => finalize())).toMatchObject({ status: 404 });
    expect((await snapshot()).stage).toBe("none");
  });
});

// Entries the fakes cannot produce, each with its reason. None today: every entry of the table is made by
// a real function in the scenarios above.
const NOT_EXERCISED: NotExercised<DigestStage>[] = [];

describe("digest stage table", () => {
  it("every move the stage functions made is allowed, and every allowed move was made", () => {
    expectConformance({
      transitions: DIGEST_STAGE_TRANSITIONS,
      canMove: canMoveDigestStage,
      moves: moves.moves,
      notExercised: NOT_EXERCISED,
    });
  });

  it("would catch a move the table does not list, and an entry nothing makes", () => {
    const withExtra = [...moves.moves, { from: "needs_script" as const, to: "ready" as const }];
    expect(() =>
      expectConformance({ transitions: DIGEST_STAGE_TRANSITIONS, canMove: canMoveDigestStage, moves: withExtra })
    ).toThrow();
    expect(() =>
      expectConformance({
        transitions: DIGEST_STAGE_TRANSITIONS,
        canMove: canMoveDigestStage,
        moves: moves.moves.filter((m) => !(m.from === "rendering" && m.to === "rendering")),
      })
    ).toThrow();
  });
});
