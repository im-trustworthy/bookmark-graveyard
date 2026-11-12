import { beforeEach, describe, expect, it, vi } from "vitest";

// hasAnalysisAttempts probes bookmarks.analysis_attempts with a one-row select. Each test loads a fresh
// copy of the module, so the remembered yes of one test does not leak into the next.
const state = vi.hoisted(() => ({
  answers: [] as ({ message: string; code?: string } | null)[],
  probes: [] as string[],
}));
vi.mock("@/lib/supabase", () => ({
  db: () => ({
    from: (table: string) => ({
      select: (columns: string) => ({
        limit: async (n: number) => {
          state.probes.push(`${table}.${columns} limit ${n}`);
          return { data: [], error: state.answers.shift() ?? null };
        },
      }),
    }),
  }),
}));

async function freshHelper() {
  vi.resetModules();
  return (await import("@/lib/analysis-attempts")).hasAnalysisAttempts;
}

beforeEach(() => {
  state.answers = [];
  state.probes = [];
});

describe("hasAnalysisAttempts", () => {
  it("is yes when the probe reads the column, asking with a one-row select", async () => {
    const has = await freshHelper();
    expect(await has()).toBe(true);
    expect(state.probes).toEqual(["bookmarks.analysis_attempts limit 1"]);
  });

  it("reads Postgres's undefined_column (42703) as no", async () => {
    const has = await freshHelper();
    state.answers = [{ message: "column bookmarks.analysis_attempts does not exist", code: "42703" }];
    expect(await has()).toBe(false);
  });

  it("throws any other error with the database's message", async () => {
    const has = await freshHelper();
    state.answers = [{ message: "permission denied for table bookmarks", code: "42501" }];
    await expect(has()).rejects.toThrow(/permission denied for table bookmarks/);
    state.answers = [{ message: "fetch failed" }];
    await expect(has()).rejects.toThrow(/fetch failed/);
  });

  it("remembers a yes, so later calls do not probe again", async () => {
    const has = await freshHelper();
    expect(await has()).toBe(true);
    expect(await has()).toBe(true);
    expect(await has()).toBe(true);
    expect(state.probes).toHaveLength(1);
  });

  it("does not remember a no, so the column is picked up once the migration lands", async () => {
    const has = await freshHelper();
    state.answers = [{ message: "missing", code: "42703" }, { message: "missing", code: "42703" }];
    expect(await has()).toBe(false);
    expect(await has()).toBe(false);
    expect(await has()).toBe(true);
    expect(await has()).toBe(true);
    expect(state.probes).toHaveLength(3);
  });
});
