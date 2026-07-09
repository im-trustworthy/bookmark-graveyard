import { describe, expect, it } from "vitest";
import { deriveDigestStage, episodeBasePath } from "../episodes";
import { LINES_PER_CALL } from "../tts";

describe("episodeBasePath", () => {
  it("strips the trailing /brief.md", () => {
    expect(episodeBasePath("user-1/2026-07-09-03-34/brief.md")).toBe("user-1/2026-07-09-03-34");
  });

  it("leaves paths without a /brief.md suffix untouched", () => {
    expect(episodeBasePath("user-1/2026-07-09-03-34/other.txt")).toBe(
      "user-1/2026-07-09-03-34/other.txt"
    );
  });
});

describe("deriveDigestStage", () => {
  it("reports needs_script when there is no script yet", () => {
    expect(deriveDigestStage({ status: "draft", scriptLength: 0, chunkStarts: [] })).toEqual({
      stage: "needs_script",
      totalLines: 0,
      nextCursor: 0,
    });
  });

  it("ignores stray chunk files when there's no script (shouldn't happen, but stage must still be needs_script)", () => {
    expect(deriveDigestStage({ status: "draft", scriptLength: 0, chunkStarts: [0, 12] })).toEqual({
      stage: "needs_script",
      totalLines: 0,
      nextCursor: 0,
    });
  });

  it("reports rendering at cursor 0 when a script exists but nothing has rendered yet", () => {
    expect(deriveDigestStage({ status: "draft", scriptLength: 43, chunkStarts: [] })).toEqual({
      stage: "rendering",
      totalLines: 43,
      nextCursor: 0,
    });
  });

  it("resumes from the LAST chunk's start, not one past it — redoing it is the safe move", () => {
    // 43 lines, chunks at 0 and 12 rendered (24-42 still to go). The chunk at
    // 12 may have been mid-upload when generation was interrupted, so the
    // resume point is 12 (redo it), not 24 (trust it and skip past it).
    expect(deriveDigestStage({ status: "draft", scriptLength: 43, chunkStarts: [0, 12] })).toEqual({
      stage: "rendering",
      totalLines: 43,
      nextCursor: 12,
    });
  });

  it("finds the max chunk start regardless of listing order", () => {
    const inOrder = deriveDigestStage({ status: "draft", scriptLength: 43, chunkStarts: [0, 12, 24] });
    const shuffled = deriveDigestStage({ status: "draft", scriptLength: 43, chunkStarts: [24, 0, 12] });
    expect(shuffled).toEqual(inOrder);
    expect(inOrder.nextCursor).toBe(24);
  });

  it("moves to needs_finalize once the highest chunk covers through the end (exact multiple of LINES_PER_CALL)", () => {
    // 36 lines = exactly 3 chunks of 12 (0, 12, 24). The chunk at 24 covers
    // lines 24-35, i.e. through the end.
    const scriptLength = LINES_PER_CALL * 3;
    expect(
      deriveDigestStage({ status: "draft", scriptLength, chunkStarts: [0, 12, 24] })
    ).toEqual({ stage: "needs_finalize", totalLines: scriptLength, nextCursor: scriptLength });
  });

  it("moves to needs_finalize once the highest chunk covers through the end (partial final chunk)", () => {
    // 43 lines: chunks at 0, 12, 24, 36 — the last covers 36-42 (7 lines, a
    // partial final chunk), which reaches totalLines.
    expect(
      deriveDigestStage({ status: "draft", scriptLength: 43, chunkStarts: [0, 12, 24, 36] })
    ).toEqual({ stage: "needs_finalize", totalLines: 43, nextCursor: 43 });
  });

  it("handles a script smaller than one chunk", () => {
    expect(deriveDigestStage({ status: "draft", scriptLength: 5, chunkStarts: [] })).toEqual({
      stage: "rendering",
      totalLines: 5,
      nextCursor: 0,
    });
    expect(deriveDigestStage({ status: "draft", scriptLength: 5, chunkStarts: [0] })).toEqual({
      stage: "needs_finalize",
      totalLines: 5,
      nextCursor: 5,
    });
  });

  it("is exact at the chunk-boundary edge (start + LINES_PER_CALL === totalLines)", () => {
    const scriptLength = 48; // 4 chunks of 12 exactly: 0, 12, 24, 36
    expect(
      deriveDigestStage({ status: "draft", scriptLength, chunkStarts: [0, 12, 24] })
    ).toEqual({ stage: "rendering", totalLines: scriptLength, nextCursor: 24 });
    expect(
      deriveDigestStage({ status: "draft", scriptLength, chunkStarts: [0, 12, 24, 36] })
    ).toEqual({ stage: "needs_finalize", totalLines: scriptLength, nextCursor: scriptLength });
  });

  it("reports ready once the episode's status is ready, regardless of chunks", () => {
    expect(deriveDigestStage({ status: "ready", scriptLength: 43, chunkStarts: [0, 12, 24, 36] })).toEqual({
      stage: "ready",
      totalLines: 43,
      nextCursor: 43,
    });
  });

  it("reports ready for a markdown-only episode (no script, status ready)", () => {
    expect(deriveDigestStage({ status: "ready", scriptLength: 0, chunkStarts: [] })).toEqual({
      stage: "ready",
      totalLines: 0,
      nextCursor: 0,
    });
  });
});
