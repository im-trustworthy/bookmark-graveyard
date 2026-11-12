import { beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/enrich: one processing chunk, with an optional {"retryFailed": true} body that puts the posts
// the analysis gave up on back in the backlog first. The pipeline functions are mocked; their own tests
// cover what they do.
const state = vi.hoisted(() => ({ userId: "u1" as string | null, order: [] as string[] }));
vi.mock("@/lib/session", () => ({ getSessionUserId: async () => state.userId }));
vi.mock("@/lib/limits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/limits")>()),
  checkUsage: vi.fn(async () => void state.order.push("checkUsage")),
}));
vi.mock("@/lib/ingest", () => ({
  ingestPending: vi.fn(async () => {
    state.order.push("ingest");
    return { ingested: 2, remaining: 4 };
  }),
}));
vi.mock("@/lib/brain", () => ({
  enrichNewBookmarks: vi.fn(async () => {
    state.order.push("enrich");
    return { enriched: 3, remaining: 9, missed: 1 };
  }),
  resetFailedAnalysis: vi.fn(async () => {
    state.order.push("reset");
    return 5;
  }),
}));

import { POST } from "@/app/api/enrich/route";
import { checkUsage, UsageLimitError } from "@/lib/limits";
import { enrichNewBookmarks, resetFailedAnalysis } from "@/lib/brain";

const post = (body?: string) =>
  POST(new Request("http://localhost/api/enrich", { method: "POST", ...(body === undefined ? {} : { body }) }));

beforeEach(() => {
  vi.clearAllMocks();
  state.userId = "u1";
  state.order = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/enrich", () => {
  it("runs one chunk and reports missed beside the other counts", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ingested: 2, enriched: 3, missed: 1, remaining: 9 });
    expect(state.order).toEqual(["checkUsage", "ingest", "enrich"]);
    expect(resetFailedAnalysis).not.toHaveBeenCalled();
    expect(enrichNewBookmarks).toHaveBeenCalledWith("u1", 60, 12);
  });

  it("with retryFailed, resets the given-up posts after the usage check and before the chunk", async () => {
    const res = await post(JSON.stringify({ retryFailed: true }));
    expect(res.status).toBe(200);
    expect(state.order).toEqual(["checkUsage", "reset", "ingest", "enrich"]);
    expect(resetFailedAnalysis).toHaveBeenCalledWith("u1");
  });

  it.each([
    ["an empty body", ""],
    ["a malformed body", "{retryFailed: true"],
    ["retryFailed false", JSON.stringify({ retryFailed: false })],
    ["retryFailed as a string", JSON.stringify({ retryFailed: "true" })],
    ["a JSON array", "[true]"],
    ["JSON null", "null"],
  ])("does not reset for %s", async (_name, body) => {
    expect((await post(body)).status).toBe(200);
    expect(resetFailedAnalysis).not.toHaveBeenCalled();
  });

  it("resets nothing once the daily enrich cap is spent", async () => {
    vi.mocked(checkUsage).mockRejectedValueOnce(new UsageLimitError("Daily limit reached for enrich"));
    const res = await post(JSON.stringify({ retryFailed: true }));
    expect(res.status).toBe(429);
    expect(resetFailedAnalysis).not.toHaveBeenCalled();
  });

  it("is 401 without a session, before any work", async () => {
    state.userId = null;
    expect((await post(JSON.stringify({ retryFailed: true }))).status).toBe(401);
    expect(state.order).toEqual([]);
  });
});
