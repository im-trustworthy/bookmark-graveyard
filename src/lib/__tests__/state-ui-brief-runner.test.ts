import { describe, expect, it } from "vitest";
import type { BriefStage, DigestStatusResponse } from "../state/ui/brief-flow";
import { resumeDraft, runAudioStages, type Post } from "../state/ui/brief-runner";

// A fake POST: the script answers `lines`; render advances `chunk` lines per call (or whatever
// `render` returns); finalize returns a marker. `fail` makes one route reject.
function fakeServer(opts: {
  lines?: number;
  chunk?: number;
  render?: (cursor: number) => unknown;
  fail?: "script" | "render" | "finalize";
}) {
  const calls: { url: string; payload: Record<string, unknown> }[] = [];
  const lines = opts.lines ?? 5;
  const chunk = opts.chunk ?? 2;
  const post: Post = async (url, payload) => {
    calls.push({ url, payload });
    const route = url.split("/").pop();
    if (route === opts.fail) throw new Error(`${route} exploded`);
    if (route === "script") return { totalLines: lines };
    if (route === "render") {
      const cursor = payload.cursor as number;
      if (opts.render) return opts.render(cursor);
      const nextCursor = Math.min(cursor + chunk, lines);
      return { nextCursor, totalLines: lines, done: nextCursor >= lines };
    }
    if (route === "finalize") return { episode: { id: payload.episodeId } };
    throw new Error(`unexpected ${url}`);
  };
  const stages: BriefStage[] = [];
  return { post, calls, stages, onStage: (s: BriefStage) => stages.push(s) };
}

const urls = (calls: { url: string }[]) => calls.map((c) => c.url.replace("/api/digest/", ""));

describe("runAudioStages", () => {
  it("runs a fresh brief: script, every chunk, finalize", async () => {
    const f = fakeServer({ lines: 5, chunk: 2 });
    const out = await runAudioStages("ep", { post: f.post, onStage: f.onStage });
    expect(out).toEqual({ episode: { id: "ep" } });
    expect(urls(f.calls)).toEqual(["script", "render", "render", "render", "finalize"]);
    expect(f.calls[0].payload).toEqual({ episodeId: "ep", targetMinutes: 20 });
    expect(f.calls.filter((c) => c.url.endsWith("render")).map((c) => c.payload.cursor)).toEqual([0, 2, 4]);
    expect(f.stages).toEqual([
      { step: "scripting" },
      { step: "rendering", cursor: 0, total: 5 },
      { step: "rendering", cursor: 2, total: 5 },
      { step: "rendering", cursor: 4, total: 5 },
      { step: "publishing" },
    ]);
  });

  it("resumes a needs_script draft from the script", async () => {
    const f = fakeServer({ lines: 2, chunk: 2 });
    await runAudioStages("ep", f, { stage: "needs_script", totalLines: 0, nextCursor: 0 });
    expect(urls(f.calls)).toEqual(["script", "render", "finalize"]);
  });

  it("resumes a rendering draft mid-way without rewriting the script", async () => {
    const f = fakeServer({ lines: 10, chunk: 3 });
    await runAudioStages("ep", f, { stage: "rendering", totalLines: 10, nextCursor: 6 });
    expect(urls(f.calls)).toEqual(["render", "render", "finalize"]);
    expect(f.stages[0]).toEqual({ step: "rendering", cursor: 6, total: 10 });
    expect(f.calls[0].payload).toEqual({ episodeId: "ep", cursor: 6 });
  });

  it("resumes a needs_finalize draft straight to publishing", async () => {
    const f = fakeServer({ lines: 10 });
    await runAudioStages("ep", f, { stage: "needs_finalize", totalLines: 10, nextCursor: 10 });
    expect(urls(f.calls)).toEqual(["finalize"]);
    expect(f.stages).toEqual([{ step: "publishing" }]);
  });

  it("stops rendering as soon as the server says done", async () => {
    const f = fakeServer({ lines: 10, render: () => ({ nextCursor: 4, done: true }) });
    await runAudioStages("ep", f);
    expect(urls(f.calls)).toEqual(["script", "render", "finalize"]);
  });

  for (const stage of ["script", "render", "finalize"] as const) {
    it(`rejects with the route's error when ${stage} fails, and goes no further`, async () => {
      const f = fakeServer({ lines: 4, fail: stage });
      await expect(runAudioStages("ep", f)).rejects.toThrow(`${stage} exploded`);
      expect(urls(f.calls).at(-1)).toBe(stage);
    });
  }

  it("throws instead of looping when a render neither advances nor says done", async () => {
    const f = fakeServer({ lines: 10, render: (cursor) => ({ nextCursor: cursor, done: false }) });
    await expect(runAudioStages("ep", f)).rejects.toThrow("Recording stopped advancing at line 1 of 10");
    expect(urls(f.calls)).toEqual(["script", "render"]);
  });

  it("treats a missing or backwards cursor as not advancing", async () => {
    const missing = fakeServer({ lines: 10, render: () => ({ done: false }) });
    await expect(
      runAudioStages("ep", missing, { stage: "rendering", totalLines: 10, nextCursor: 4 })
    ).rejects.toThrow("Recording stopped advancing at line 5 of 10");
    const backwards = fakeServer({ lines: 10, render: () => ({ nextCursor: 1, done: false }) });
    await expect(
      runAudioStages("ep", backwards, { stage: "rendering", totalLines: 10, nextCursor: 4 })
    ).rejects.toThrow("Recording stopped advancing");
  });
});

describe("resumeDraft", () => {
  const status = (s: Partial<DigestStatusResponse>): DigestStatusResponse => ({
    episodeId: "ep",
    stage: "rendering",
    totalLines: 10,
    nextCursor: 0,
    markdownReady: true,
    ...s,
  });

  it("continues from the fresh stage and cursor, not the cached ones", async () => {
    const f = fakeServer({ lines: 10, chunk: 5 });
    const out = await resumeDraft("ep", {
      ...f,
      getStatus: async () => status({ stage: "rendering", totalLines: 10, nextCursor: 5 }),
    });
    expect(out).toEqual({ kind: "published", finalized: { episode: { id: "ep" } } });
    expect(urls(f.calls)).toEqual(["render", "finalize"]);
    expect(f.calls[0].payload.cursor).toBe(5);
  });

  it("reports a draft finished elsewhere without posting anything", async () => {
    const f = fakeServer({});
    expect(await resumeDraft("ep", { ...f, getStatus: async () => status({ stage: "ready" }) })).toEqual({
      kind: "finished",
    });
    expect(f.calls).toEqual([]);
  });

  it("reports a deleted (404) or no-longer-resumable draft as gone", async () => {
    const f = fakeServer({});
    expect(await resumeDraft("ep", { ...f, getStatus: async () => null })).toEqual({ kind: "gone" });
    expect(await resumeDraft("ep", { ...f, getStatus: async () => status({ stage: "none" }) })).toEqual({
      kind: "gone",
    });
    expect(f.calls).toEqual([]);
  });

  it("passes a failed status read through as an error", async () => {
    const f = fakeServer({});
    await expect(
      resumeDraft("ep", {
        ...f,
        getStatus: async () => {
          throw new Error("Couldn't check brief status");
        },
      })
    ).rejects.toThrow("Couldn't check brief status");
  });
});
