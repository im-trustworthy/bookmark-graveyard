import { describe, expect, it } from "vitest";
import {
  audioAvailability,
  canMoveDigestStage,
  DIGEST_STAGE_TRANSITIONS,
  DIGEST_STAGES,
  deriveDigestStage,
  EPISODE_STATUS,
  EPISODE_STATUSES,
  episodeRowState,
  isEpisodeStatus,
  isResumableStage,
  LINES_PER_CALL,
  RESUMABLE_STAGES,
  scriptLengthOf,
} from "../state/episode";
import type { DigestStage } from "../state/episode";
import * as episodes from "../episodes";
import * as tts from "../tts";

describe("episode statuses", () => {
  it("are the three the database CHECK allows, each named by EPISODE_STATUS", () => {
    expect(EPISODE_STATUSES).toEqual(["draft", "ready", "failed"]);
    for (const status of EPISODE_STATUSES) expect(EPISODE_STATUS[status]).toBe(status);
  });

  it("isEpisodeStatus accepts exactly those", () => {
    for (const status of EPISODE_STATUSES) expect(isEpisodeStatus(status)).toBe(true);
    for (const other of ["", "Draft", "published", null, undefined, 0]) expect(isEpisodeStatus(other)).toBe(false);
  });
});

describe("DIGEST_STAGE_TRANSITIONS", () => {
  // Every legal move and the stage function that makes it; every other pair is illegal.
  const legal: [DigestStage, DigestStage][] = [
    ["none", "needs_script"], // prepare: podcast draft
    ["none", "ready"], // prepare: markdown-only
    ["needs_script", "rendering"], // script
    ["rendering", "rendering"], // render, more chunks to go
    ["rendering", "needs_finalize"], // render, last chunk
    ["needs_finalize", "ready"], // finalize
    ["needs_script", "none"], // discard
    ["rendering", "none"], // discard
    ["needs_finalize", "none"], // discard
  ];
  const isLegal = (from: DigestStage, to: DigestStage) => legal.some(([f, t]) => f === from && t === to);
  const pairs = DIGEST_STAGES.flatMap((from) => DIGEST_STAGES.map((to) => [from, to] as const));

  it("has a row for every stage", () => {
    expect(Object.keys(DIGEST_STAGE_TRANSITIONS).sort()).toEqual([...DIGEST_STAGES].sort());
  });

  it.each(pairs)("%s -> %s", (from, to) => {
    expect(canMoveDigestStage(from, to)).toBe(isLegal(from, to));
  });

  it("leaves ready with nowhere to go", () => {
    expect(DIGEST_STAGE_TRANSITIONS.ready).toEqual([]);
  });
});

describe("isResumableStage", () => {
  it.each(DIGEST_STAGES)("%s", (stage) => {
    expect(isResumableStage(stage)).toBe(["needs_script", "rendering", "needs_finalize"].includes(stage));
  });

  it("matches RESUMABLE_STAGES, and every resumable stage can be discarded", () => {
    expect(RESUMABLE_STAGES).toEqual(["needs_script", "rendering", "needs_finalize"]);
    for (const stage of RESUMABLE_STAGES) expect(canMoveDigestStage(stage, "none")).toBe(true);
  });
});

describe("episodeRowState", () => {
  it.each([
    { status: "draft", scriptLength: 0, state: "unscripted_draft" },
    { status: "draft", scriptLength: 1, state: "scripted_draft" },
    { status: "draft", scriptLength: 43, state: "scripted_draft" },
    { status: "ready", scriptLength: 0, state: "ready" },
    { status: "ready", scriptLength: 43, state: "ready" },
    { status: "failed", scriptLength: 0, state: "failed" },
    { status: "failed", scriptLength: 43, state: "failed" },
    { status: "something-else", scriptLength: 43, state: "failed" },
  ])("$status with $scriptLength lines is $state", ({ status, scriptLength, state }) => {
    expect(episodeRowState({ status, scriptLength })).toBe(state);
  });
});

describe("audioAvailability", () => {
  it.each([
    { audio_path: null, audio_pruned_at: null, availability: "none" },
    { audio_path: "u1/ep/brief.mp3", audio_pruned_at: null, availability: "available" },
    { audio_path: null, audio_pruned_at: "2026-10-01T00:00:00.000Z", availability: "pruned" },
    { audio_path: "u1/ep/brief.mp3", audio_pruned_at: "2026-10-01T00:00:00.000Z", availability: "pruned" },
  ])("path $audio_path, pruned $audio_pruned_at -> $availability", ({ availability, ...episode }) => {
    expect(audioAvailability(episode)).toBe(availability);
  });
});

describe("scriptLengthOf", () => {
  it("counts an array's lines and treats anything else as no script", () => {
    expect(scriptLengthOf([{}, {}, {}])).toBe(3);
    expect(scriptLengthOf([])).toBe(0);
    expect(scriptLengthOf(null)).toBe(0);
    expect(scriptLengthOf(undefined)).toBe(0);
    expect(scriptLengthOf({ length: 4 })).toBe(0);
  });
});

describe("deriveDigestStage", () => {
  // The cases episodes.test.ts pins, run against this module directly: same input, same answer.
  it.each([
    [{ status: "draft", scriptLength: 0, chunkStarts: [] }, { stage: "needs_script", totalLines: 0, nextCursor: 0 }],
    [{ status: "draft", scriptLength: 0, chunkStarts: [0, 12] }, { stage: "needs_script", totalLines: 0, nextCursor: 0 }],
    [{ status: "draft", scriptLength: 43, chunkStarts: [] }, { stage: "rendering", totalLines: 43, nextCursor: 0 }],
    [{ status: "draft", scriptLength: 43, chunkStarts: [0, 12] }, { stage: "rendering", totalLines: 43, nextCursor: 12 }],
    [{ status: "draft", scriptLength: 43, chunkStarts: [24, 0, 12] }, { stage: "rendering", totalLines: 43, nextCursor: 24 }],
    [{ status: "draft", scriptLength: 36, chunkStarts: [0, 12, 24] }, { stage: "needs_finalize", totalLines: 36, nextCursor: 36 }],
    [{ status: "draft", scriptLength: 43, chunkStarts: [0, 12, 24, 36] }, { stage: "needs_finalize", totalLines: 43, nextCursor: 43 }],
    [{ status: "draft", scriptLength: 5, chunkStarts: [] }, { stage: "rendering", totalLines: 5, nextCursor: 0 }],
    [{ status: "draft", scriptLength: 5, chunkStarts: [0] }, { stage: "needs_finalize", totalLines: 5, nextCursor: 5 }],
    [{ status: "draft", scriptLength: 48, chunkStarts: [0, 12, 24] }, { stage: "rendering", totalLines: 48, nextCursor: 24 }],
    [{ status: "draft", scriptLength: 48, chunkStarts: [0, 12, 24, 36] }, { stage: "needs_finalize", totalLines: 48, nextCursor: 48 }],
    [{ status: "ready", scriptLength: 43, chunkStarts: [0, 12, 24, 36] }, { stage: "ready", totalLines: 43, nextCursor: 43 }],
    [{ status: "ready", scriptLength: 0, chunkStarts: [] }, { stage: "ready", totalLines: 0, nextCursor: 0 }],
    // A failed row, or a status the CHECK doesn't admit, is what episodeRowState calls failed: no stage acts on it.
    [{ status: "failed", scriptLength: 43, chunkStarts: [0] }, { stage: "none", totalLines: 0, nextCursor: 0 }],
    [{ status: "failed", scriptLength: 0, chunkStarts: [] }, { stage: "none", totalLines: 0, nextCursor: 0 }],
    [{ status: "something-else", scriptLength: 43, chunkStarts: [0, 12] }, { stage: "none", totalLines: 0, nextCursor: 0 }],
    [{ status: "", scriptLength: 0, chunkStarts: [] }, { stage: "none", totalLines: 0, nextCursor: 0 }],
  ])("%j", (input, expected) => {
    expect(deriveDigestStage(input)).toEqual(expected);
  });

  it("is what src/lib/episodes.ts and src/lib/tts.ts still export", () => {
    expect(episodes.deriveDigestStage).toBe(deriveDigestStage);
    expect(tts.LINES_PER_CALL).toBe(LINES_PER_CALL);
    expect(LINES_PER_CALL).toBe(12);
  });
});
