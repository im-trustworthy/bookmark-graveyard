import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./fake-db";
import type { FakeDb } from "./fake-db";
import type { VoiceProvider } from "../voice";

// Video ingest wiring: one provider per batch from the user's settings, the
// downloaded bytes handed to transcribe(), and the thumbnail fallback.
const state = vi.hoisted(() => ({ db: null as unknown, provider: null as unknown }));
vi.mock("../supabase", () => ({ db: () => state.db }));
vi.mock("../grok", () => ({
  FAST_MODEL: "fast-model",
  grokText: vi.fn(async () => "Thumbnail: a chart of GPU prices"),
  grokJson: vi.fn(),
  grokSearchText: vi.fn(),
}));
vi.mock("../voice/user", () => ({
  getVoiceProviderForUser: vi.fn(async () => {
    if (state.provider instanceof Error) throw state.provider;
    return state.provider;
  }),
}));

import { ingestPending } from "../ingest";
import { getVoiceProviderForUser } from "../voice/user";

const VIDEO_URL = "https://video.twimg.com/clip.mp4";
const THUMBNAIL = "https://pbs.twimg.com/thumb.jpg";

let fake: FakeDb;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

function stubProvider(transcribe: VoiceProvider["transcribe"]): VoiceProvider {
  return { id: "grok", synthesize: vi.fn(), transcribe: vi.fn(transcribe) };
}

beforeEach(() => {
  fake = createFakeDb({
    bookmarks: [
      {
        user_id: "user-1",
        tweet_id: "42",
        author_handle: "someone",
        text: "Watch this",
        entities: null,
        referenced: null,
        ingested_at: null,
        media: [
          {
            type: "video",
            preview_image_url: THUMBNAIL,
            duration_ms: 30_000,
            variants: [{ content_type: "video/mp4", bit_rate: 256_000, url: VIDEO_URL }],
          },
        ],
      },
    ],
    bookmark_sources: [],
  });
  state.db = fake;
  fetchMock = vi.fn<typeof fetch>(async (input) => {
    if (String(input) !== VIDEO_URL) throw new Error(`unexpected fetch ${String(input)}`);
    return new Response(new Uint8Array([1, 2, 3, 4, 5]));
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ingestPending video transcription", () => {
  it("hands the downloaded bytes to the user's provider and stores the transcript", async () => {
    const provider = stubProvider(async () => "hello from the clip");
    state.provider = provider;

    expect(await ingestPending("user-1")).toEqual({ ingested: 1, remaining: 0 });
    expect(getVoiceProviderForUser).toHaveBeenCalledExactlyOnceWith("user-1");
    const [media, mimeType, filename] = vi.mocked(provider.transcribe).mock.calls[0];
    expect([...new Uint8Array(media as ArrayBuffer)]).toEqual([1, 2, 3, 4, 5]);
    expect([mimeType, filename]).toEqual(["video/mp4", "video.mp4"]);
    expect(fake.tables.bookmark_sources).toEqual([
      expect.objectContaining({ kind: "video", url: VIDEO_URL, title: "transcript", content: "hello from the clip", status: "ok" }),
    ]);
    expect(fake.tables.bookmarks[0].ingested_at).toEqual(expect.any(String));
  });

  it("falls back to the thumbnail, without downloading, when no provider resolves", async () => {
    state.provider = new Error("No voice provider configured");

    await ingestPending("user-1");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fake.tables.bookmark_sources).toEqual([
      expect.objectContaining({
        kind: "video",
        url: THUMBNAIL,
        title: "thumbnail description (no transcript)",
        content: "Thumbnail: a chart of GPU prices",
        status: "ok",
      }),
    ]);
  });

  it("falls back to the thumbnail when transcription itself fails", async () => {
    state.provider = stubProvider(async () => {
      throw new Error("Grok STT failed (500): boom");
    });

    await ingestPending("user-1");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fake.tables.bookmark_sources).toEqual([
      expect.objectContaining({ kind: "video", title: "thumbnail description (no transcript)" }),
    ]);
  });
});

describe("ingestPending video limits", () => {
  const minutes = (n: number) => n * 60_000;
  const setDuration = (ms: number) => {
    (fake.tables.bookmarks[0].media as { duration_ms: number }[])[0].duration_ms = ms;
  };

  it("transcribes videos up to an hour long", async () => {
    setDuration(minutes(59));
    state.provider = stubProvider(async () => "an hour of talk");

    await ingestPending("user-1");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fake.tables.bookmark_sources).toEqual([
      expect.objectContaining({ kind: "video", title: "transcript", content: "an hour of talk" }),
    ]);
  });

  it("skips the download for videos over an hour and falls back to the thumbnail", async () => {
    setDuration(minutes(61));
    const provider = stubProvider(async () => "never used");
    state.provider = provider;

    await ingestPending("user-1");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(provider.transcribe).not.toHaveBeenCalled();
    expect(fake.tables.bookmark_sources).toEqual([
      expect.objectContaining({ kind: "video", title: "thumbnail description (no transcript)" }),
    ]);
  });

  it("falls back to the thumbnail when the download exceeds 160 MB", async () => {
    const provider = stubProvider(async () => "never used");
    state.provider = provider;
    fetchMock.mockImplementation(
      async () => ({ ok: true, arrayBuffer: async () => ({ byteLength: 161 * 1024 * 1024 }) }) as unknown as Response
    );

    await ingestPending("user-1");
    expect(provider.transcribe).not.toHaveBeenCalled();
    expect(fake.tables.bookmark_sources).toEqual([
      expect.objectContaining({ kind: "video", title: "thumbnail description (no transcript)" }),
    ]);
  });
});
