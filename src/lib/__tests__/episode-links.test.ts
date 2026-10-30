import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createFakeDb } from "./fake-db";
import type { FakeDb } from "./fake-db";
import { audioEpisode, withBucketMethods } from "./capacity-fixtures";

// GET /api/episodes/[id]/audio and /markdown: the stable links an assistant hands out. Each checks the
// caller (session cookie or a read token), then answers 302 to a fresh one-hour signed URL.
const state = vi.hoisted(() => ({ db: null as unknown, userId: null as string | null }));
vi.mock("@/lib/session", () => ({ getSessionUserId: async () => state.userId }));
vi.mock("@/lib/supabase", () => ({ db: () => state.db }));

import { GET as audioRoute } from "@/app/api/episodes/[id]/audio/route";
import { GET as markdownRoute } from "@/app/api/episodes/[id]/markdown/route";
import { mintApiToken } from "@/lib/api-tokens";

const BROWSER = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

let fake: FakeDb;
/** Every createSignedUrl call: the path and how long the URL lives. */
let signed: { path: string; expiresIn: number }[];
let readToken: string;
const ids = { ready: "", markdownOnly: "", pruned: "", draft: "", theirs: "" };

type Route = typeof audioRoute;
function call(route: Route, id: string, headers: Record<string, string> = {}): Promise<Response> {
  const file = route === audioRoute ? "audio" : "markdown";
  return route(new NextRequest(`http://localhost/api/episodes/${id}/${file}`, { headers }), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(async () => {
  for (const key of Object.keys(ids) as (keyof typeof ids)[]) ids[key] = randomUUID();
  fake = createFakeDb({
    users: [
      { id: "u1", is_allowed: true },
      { id: "u2", is_allowed: true },
    ],
    api_tokens: [],
    episodes: [
      audioEpisode(ids.ready, "u1", "2026-10-06T09:00:00.000Z"),
      audioEpisode(ids.markdownOnly, "u1", "2026-10-05T09:00:00.000Z", { format: "markdown", audio_path: null }),
      audioEpisode(ids.pruned, "u1", "2026-10-04T09:00:00.000Z", {
        audio_path: null,
        audio_pruned_at: "2026-10-20T00:00:00.000Z",
      }),
      audioEpisode(ids.draft, "u1", "2026-10-03T09:00:00.000Z", { status: "draft" }),
      audioEpisode(ids.theirs, "u2", "2026-10-02T09:00:00.000Z"),
    ],
  });
  signed = [];
  state.db = withBucketMethods(fake, {
    createSignedUrl: async (path: string, expiresIn: number) => {
      signed.push({ path, expiresIn });
      return { data: { signedUrl: `https://storage.test/signed/${path}?token=t` }, error: null };
    },
  });
  state.userId = null;
  readToken = (await mintApiToken("u1", { name: "Grok", scopes: ["read"] })).token;
  vi.spyOn(console, "error").mockImplementation(() => {}); // apiError logs every rejection
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function expectRedirectTo(res: Response, path: string) {
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe(`https://storage.test/signed/${path}?token=t`);
  expect(res.headers.get("cache-control")).toBe("private, no-store");
}

async function expectError(res: Response, status: number, message: RegExp) {
  expect(res.status).toBe(status);
  expect((await res.json()).error).toMatch(message);
}

describe("signed in", () => {
  it("redirects a session cookie to a fresh one-hour signed URL for the audio", async () => {
    state.userId = "u1";
    await expectRedirectTo(await call(audioRoute, ids.ready), `u1/${ids.ready}/brief.mp3`);
    expect(signed).toEqual([{ path: `u1/${ids.ready}/brief.mp3`, expiresIn: 3600 }]);
  });

  it("redirects a read bearer token to the markdown, and a write token too", async () => {
    await expectRedirectTo(
      await call(markdownRoute, ids.ready, { authorization: `Bearer ${readToken}` }),
      `u1/${ids.ready}/brief.md`
    );
    const writeToken = (await mintApiToken("u1", { name: "rw", scopes: ["write"] })).token;
    await expectRedirectTo(
      await call(audioRoute, ids.ready, { authorization: `Bearer ${writeToken}` }),
      `u1/${ids.ready}/brief.mp3`
    );
  });

  it("answers 404 for someone else's brief, a draft and an unknown id", async () => {
    state.userId = "u1";
    for (const id of [ids.theirs, ids.draft, randomUUID()]) {
      await expectError(await call(audioRoute, id), 404, /^Episode not found/);
      await expectError(await call(markdownRoute, id), 404, /^Episode not found/);
    }
    expect(signed).toEqual([]);
  });

  it("answers 404 for an id that isn't a uuid, without asking the database", async () => {
    state.userId = "u1";
    const from = vi.spyOn(fake, "from");
    await expectError(await call(audioRoute, "not-a-uuid"), 404, /^Episode not found/);
    expect(from).not.toHaveBeenCalled();
  });

  it("says when the audio was pruned, while the markdown still opens", async () => {
    state.userId = "u1";
    await expectError(await call(audioRoute, ids.pruned), 404, /^This episode's audio was pruned to free space/);
    await expectRedirectTo(await call(markdownRoute, ids.pruned), `u1/${ids.pruned}/brief.md`);
  });

  it("says a markdown-only brief has no audio", async () => {
    state.userId = "u1";
    await expectError(await call(audioRoute, ids.markdownOnly), 404, /^This episode has no audio/);
  });
});

describe("not signed in", () => {
  it("answers an API caller 401 JSON", async () => {
    await expectError(await call(audioRoute, ids.ready), 401, /^Not logged in/);
    await expectError(await call(markdownRoute, ids.ready, { accept: "application/json" }), 401, /^Not logged in/);
    await expectError(
      await call(markdownRoute, ids.ready, { authorization: `Bearer bg_${"x".repeat(43)}` }),
      401,
      /^Not logged in/
    );
  });

  it("sends a browser to the home page to sign in", async () => {
    for (const route of [audioRoute, markdownRoute]) {
      const res = await call(route, ids.ready, { accept: BROWSER });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("http://localhost/");
    }
    expect(signed).toEqual([]);
  });
});
