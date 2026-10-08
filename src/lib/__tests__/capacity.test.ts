import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./fake-db";
import { clearCapacityEnv, fakeProject, MB, prunedBrief, twoPeopleProject } from "./capacity-fixtures";
import type { CapacityEnvVar } from "./capacity-fixtures";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase", () => ({ db: () => state.db }));

import { CapacityError, ensureRoomFor, getCapacity, pruneAudio } from "@/lib/capacity";

let fake: FakeDb;

function install(project: FakeDb): FakeDb {
  fake = project;
  state.db = project;
  return project;
}
/** Storage and database usage against limits of 1000 bytes each, so bytes read as tenths of a percent. */
function usage(storageBytes: number, databaseBytes: number, env: Partial<Record<CapacityEnvVar, string>> = {}) {
  clearCapacityEnv({ STORAGE_LIMIT_BYTES: "1000", DATABASE_LIMIT_BYTES: "1000", ...env });
  install(fakeProject({ episodes: [], otherBytes: storageBytes, databaseBytes }));
}
const row = (id: string, userId?: string) =>
  fake.tables.episodes.find((r) => r.id === id && (!userId || r.user_id === userId)) as Record<string, unknown>;
const removedPaths = () => fake.removals.flatMap((r) => r.paths);
const usageReads = () => vi.mocked(fake.functions.storage_usage_bytes).mock.calls.length;

beforeEach(() => {
  clearCapacityEnv();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("getCapacity", () => {
  it("measures both against the free-tier limits by default", async () => {
    install(fakeProject({ episodes: [], otherBytes: 901_943_132, databaseBytes: 15_728_640 })); // 84% of 1 GiB, 3% of 500 MiB
    expect(await getCapacity()).toEqual({
      storage: { usedBytes: 901_943_132, limitBytes: 1_073_741_824, ratio: 0.8399999998509884 },
      database: { usedBytes: 15_728_640, limitBytes: 524_288_000, ratio: 0.03 },
      level: "warn",
      autoPrune: true,
      keepRecent: 4,
      recommendation:
        "Storage is 84% full. Oldest podcast audio is removed automatically once it reaches 90% (the newest 4 briefs per person are always kept).",
    });
  });

  it.each([
    { storage: 500, database: 30, level: "ok" },
    { storage: 799, database: 799, level: "ok" },
    { storage: 800, database: 30, level: "warn" },
    { storage: 899, database: 30, level: "warn" },
    { storage: 900, database: 30, level: "critical" },
    { storage: 1200, database: 30, level: "critical" },
    { storage: 30, database: 800, level: "warn" },
    { storage: 850, database: 950, level: "critical" },
    { storage: 950, database: 850, level: "critical" },
  ])("storage $storage/1000, database $database/1000 → $level", async ({ storage, database, level }) => {
    usage(storage, database);
    const report = await getCapacity();
    expect(report.level).toBe(level);
    expect(report.storage).toEqual({ usedBytes: storage, limitBytes: 1000, ratio: storage / 1000 });
    expect(report.database).toEqual({ usedBytes: database, limitBytes: 1000, ratio: database / 1000 });
  });

  const STORAGE_CRITICAL_OFF =
    "Storage is almost full (93%) — new podcast audio will be refused until space is freed. Remove old podcast audio, or raise STORAGE_LIMIT_BYTES.";
  const DATABASE_WARN =
    "The database is 82% full. Bookmark data is never pruned automatically — upgrade the Supabase plan, or raise DATABASE_LIMIT_BYTES if your plan allows more.";
  it.each([
    { case: "both under 80%", storage: 799, database: 799, env: {}, text: null },
    {
      case: "storage warn, auto-prune on",
      storage: 840,
      database: 30,
      env: {},
      text: "Storage is 84% full. Oldest podcast audio is removed automatically once it reaches 90% (the newest 4 briefs per person are always kept).",
    },
    {
      case: "storage warn, auto-prune off",
      storage: 840,
      database: 30,
      env: { AUTO_PRUNE_AUDIO: "off" },
      text: "Storage is 84% full. Free up space by removing old podcast audio, or raise STORAGE_LIMIT_BYTES.",
    },
    {
      case: "storage critical, auto-prune on",
      storage: 930,
      database: 30,
      env: {},
      text: "Storage is almost full (93%). Oldest podcast audio is removed automatically before the next brief is saved (the newest 4 briefs per person are always kept).",
    },
    {
      case: "storage critical, auto-prune off",
      storage: 930,
      database: 30,
      env: { AUTO_PRUNE_AUDIO: "false" },
      text: STORAGE_CRITICAL_OFF,
    },
    {
      case: "one brief kept per person",
      storage: 840,
      database: 30,
      env: { KEEP_RECENT_AUDIO: "1" },
      text: "Storage is 84% full. Oldest podcast audio is removed automatically once it reaches 90% (the newest brief per person is always kept).",
    },
    {
      case: "nothing kept",
      storage: 840,
      database: 30,
      env: { KEEP_RECENT_AUDIO: "0" },
      text: "Storage is 84% full. Oldest podcast audio is removed automatically once it reaches 90%.",
    },
    { case: "database warn", storage: 500, database: 820, env: {}, text: DATABASE_WARN },
    {
      case: "database critical: almost full, same remedy, never pruned",
      storage: 500,
      database: 930,
      env: {},
      text: "The database is almost full (93%). Bookmark data is never pruned automatically — upgrade the Supabase plan, or raise DATABASE_LIMIT_BYTES if your plan allows more.",
    },
    {
      case: "both: storage first",
      storage: 930,
      database: 820,
      env: { AUTO_PRUNE_AUDIO: "no" },
      text: `${STORAGE_CRITICAL_OFF} ${DATABASE_WARN}`,
    },
  ])("recommendation: $case", async ({ storage, database, env, text }) => {
    usage(storage, database, env);
    expect((await getCapacity()).recommendation).toBe(text);
  });

  it("STORAGE_LIMIT_BYTES and DATABASE_LIMIT_BYTES replace the free-tier limits", async () => {
    clearCapacityEnv({ STORAGE_LIMIT_BYTES: " 1e11 ", DATABASE_LIMIT_BYTES: "8589934592" });
    install(fakeProject({ episodes: [], otherBytes: 2 * 1024 ** 3, databaseBytes: 15 * MB }));
    const report = await getCapacity();
    expect(report.storage).toEqual({ usedBytes: 2 * 1024 ** 3, limitBytes: 1e11, ratio: (2 * 1024 ** 3) / 1e11 });
    expect(report.database.limitBytes).toBe(8_589_934_592);
    expect(report).toMatchObject({ level: "ok", recommendation: null });
  });

  it("blank settings mean the defaults", async () => {
    clearCapacityEnv({ STORAGE_LIMIT_BYTES: "", DATABASE_LIMIT_BYTES: "  ", AUTO_PRUNE_AUDIO: "", KEEP_RECENT_AUDIO: " " });
    install(fakeProject({ episodes: [] }));
    expect(await getCapacity()).toMatchObject({
      storage: { limitBytes: 1_073_741_824 },
      database: { limitBytes: 524_288_000 },
      autoPrune: true,
      keepRecent: 4,
    });
  });

  it.each(["0", "false", "no", "off", "FALSE", " Off "])("AUTO_PRUNE_AUDIO=%j turns auto-pruning off", async (value) => {
    clearCapacityEnv({ AUTO_PRUNE_AUDIO: value });
    install(fakeProject({ episodes: [] }));
    expect((await getCapacity()).autoPrune).toBe(false);
  });

  it.each(["1", "true", "yes", "on", "anything"])("AUTO_PRUNE_AUDIO=%j leaves it on", async (value) => {
    clearCapacityEnv({ AUTO_PRUNE_AUDIO: value });
    install(fakeProject({ episodes: [] }));
    expect((await getCapacity()).autoPrune).toBe(true);
  });

  it.each([
    ["0", 0],
    ["10", 10],
  ])("KEEP_RECENT_AUDIO=%j keeps %i", async (value, keepRecent) => {
    clearCapacityEnv({ KEEP_RECENT_AUDIO: value });
    install(fakeProject({ episodes: [] }));
    expect((await getCapacity()).keepRecent).toBe(keepRecent);
  });

  it.each([
    ["STORAGE_LIMIT_BYTES", "1GB"],
    ["STORAGE_LIMIT_BYTES", "0"],
    ["DATABASE_LIMIT_BYTES", "-524288000"],
    ["KEEP_RECENT_AUDIO", "four"],
    ["KEEP_RECENT_AUDIO", "-1"],
    ["KEEP_RECENT_AUDIO", "2.5"],
  ] as const)("rejects %s=%j instead of guessing", async (name, value) => {
    clearCapacityEnv({ [name]: value });
    install(fakeProject({ episodes: [] }));
    await expect(getCapacity()).rejects.toThrow(`Invalid ${name} "${value}": use a `);
  });

  it("reads the settings on every call", async () => {
    install(fakeProject({ episodes: [], otherBytes: 500 }));
    expect((await getCapacity()).storage.limitBytes).toBe(1_073_741_824);
    vi.stubEnv("STORAGE_LIMIT_BYTES", "1000");
    expect((await getCapacity()).storage).toMatchObject({ limitBytes: 1000, ratio: 0.5 });
  });

  it("accepts a bigint that arrives as a string", async () => {
    install(fakeProject({ episodes: [] }));
    fake.functions.storage_usage_bytes = () => "901943132";
    expect((await getCapacity()).storage.usedBytes).toBe(901_943_132);
  });

  it("fails naming the function when one is missing (migration not applied)", async () => {
    install(fakeProject({ episodes: [] }));
    delete fake.functions.database_size_bytes;
    await expect(getCapacity()).rejects.toThrow(
      "database_size_bytes() failed: Could not find the function public.database_size_bytes"
    );
  });
});

describe("pruneAudio", () => {
  beforeEach(() => {
    clearCapacityEnv({ STORAGE_LIMIT_BYTES: String(1000 * MB), KEEP_RECENT_AUDIO: "2" });
    install(twoPeopleProject()); // 1000 MB in use; candidates oldest first: b1, a1, a2
  });

  it("removes the oldest audio first, re-measuring after each file, until storage is back at 80%", async () => {
    expect(await pruneAudio()).toEqual({ pruned: [prunedBrief("b1"), prunedBrief("a1")], usedBytes: 800 * MB });
    expect(fake.removals).toEqual([
      { bucket: "episodes", paths: ["u2/b1/brief.mp3"] },
      { bucket: "episodes", paths: ["u1/a1/brief.mp3"] },
    ]);
    expect(usageReads()).toBe(3); // before, then after each removal
    expect(row("a2").audio_path).toBe("u1/a2/brief.mp3");
  });

  it("clears audio_path and stamps audio_pruned_at on the row, scoped by id and user; brief.md and the row stay", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T12:00:00.000Z"));
    // Ids are unique in Postgres; this decoy only shows the update filters on the user too.
    fake.tables.episodes.push({ id: "b1", user_id: "u3", status: "draft", audio_path: "u3/b1/brief.mp3" });
    const rowsBefore = fake.tables.episodes.length;

    await pruneAudio();
    expect(row("b1", "u2")).toMatchObject({
      audio_path: null,
      audio_pruned_at: "2026-10-07T12:00:00.000Z",
      markdown_path: "u2/b1/brief.md",
      status: "ready",
    });
    expect(row("b1", "u3").audio_path).toBe("u3/b1/brief.mp3");
    expect(fake.tables.episodes).toHaveLength(rowsBefore);
    expect(removedPaths().every((path) => path.endsWith("/brief.mp3"))).toBe(true);
  });

  it("keeps each person's newest KEEP_RECENT_AUDIO briefs even when that leaves storage over target; drafts, markdown-only and already-pruned briefs are never candidates", async () => {
    const result = await pruneAudio({ targetBytes: 0 });
    expect(result).toEqual({
      pruned: [prunedBrief("b1"), prunedBrief("a1"), prunedBrief("a2")],
      usedBytes: 700 * MB,
    });
    expect(removedPaths()).toEqual(["u2/b1/brief.mp3", "u1/a1/brief.mp3", "u1/a2/brief.mp3"]);
    expect(row("draft").audio_path).toBe("u1/draft/brief.mp3");
  });

  it("keeps the newest 4 per person by default", async () => {
    vi.stubEnv("KEEP_RECENT_AUDIO", undefined);
    expect(await pruneAudio({ targetBytes: 0 })).toEqual({ pruned: [], usedBytes: 1000 * MB });
    expect(fake.removals).toEqual([]);
  });

  it("with a userId only that person's audio is a candidate, against the instance-wide target", async () => {
    expect(await pruneAudio({ userId: "u1" })).toEqual({
      pruned: [prunedBrief("a1"), prunedBrief("a2")],
      usedBytes: 800 * MB,
    });
    expect(row("b1").audio_path).toBe("u2/b1/brief.mp3");

    // u2 has a single candidate: it goes, and that's all u2 can do
    expect(await pruneAudio({ userId: "u2", targetBytes: 0 })).toEqual({
      pruned: [prunedBrief("b1")],
      usedBytes: 700 * MB,
    });
  });

  it("does nothing at or under the target", async () => {
    install(twoPeopleProject(100 * MB)); // 800 MB
    expect(await pruneAudio()).toEqual({ pruned: [], usedBytes: 800 * MB });
    expect(fake.removals).toEqual([]);
  });

  it("a dry run estimates each file from its duration (16 kB/s) and touches nothing", async () => {
    row("b1").duration_seconds = 15_625; // estimated 250 MB: alone enough to reach 800 MB
    const before = structuredClone(fake.tables);

    expect(await pruneAudio({ dryRun: true })).toEqual({ pruned: [prunedBrief("b1")], usedBytes: 750 * MB });
    expect(fake.removals).toEqual([]);
    expect(fake.tables).toEqual(before);
    expect(usageReads()).toBe(1);

    // 900 s briefs are an estimated 14.4 MB each: every candidate would go
    expect(await pruneAudio({ dryRun: true, userId: "u1" })).toEqual({
      pruned: [prunedBrief("a1"), prunedBrief("a2")],
      usedBytes: 1000 * MB - 2 * 900 * 16_000,
    });
    expect(fake.removals).toEqual([]);
  });

  it("stops before touching the row when a file can't be removed", async () => {
    const bucket = fake.storage.from;
    fake.storage.from = (name) => ({
      ...bucket(name),
      remove: async () => ({ data: null, error: { message: "storage down" } }),
    });
    await expect(pruneAudio()).rejects.toThrow("Removing u2/b1/brief.mp3 failed: storage down");
    expect(row("b1")).toMatchObject({ audio_path: "u2/b1/brief.mp3", audio_pruned_at: null });
  });
});

describe("ensureRoomFor", () => {
  beforeEach(() => {
    // 1000 MB limit: critical from 900 MB, pruning aims for 800 MB minus the new file.
    clearCapacityEnv({ STORAGE_LIMIT_BYTES: String(1000 * MB), KEEP_RECENT_AUDIO: "2" });
  });

  it("lets the file through untouched when there's room, up to exactly 90%", async () => {
    install(twoPeopleProject(150 * MB)); // 850 MB
    await expect(ensureRoomFor(50 * MB)).resolves.toBeUndefined();
    expect(fake.removals).toEqual([]);
    expect(usageReads()).toBe(1);
  });

  it("prunes the oldest audio instance-wide to 80% minus the new file, then lets it through", async () => {
    install(twoPeopleProject(190 * MB)); // 890 MB; +20 MB would be 91%
    await expect(ensureRoomFor(20 * MB)).resolves.toBeUndefined();
    // target 780 MB: b1 (u2) → 790 MB, a1 (u1) → 690 MB
    expect(removedPaths()).toEqual(["u2/b1/brief.mp3", "u1/a1/brief.mp3"]);
    expect(row("a2").audio_path).toBe("u1/a2/brief.mp3");
  });

  it("throws CapacityError when pruning everything it may still leaves no room", async () => {
    install(twoPeopleProject(600 * MB)); // 1300 MB
    const attempt = ensureRoomFor(20 * MB);
    await expect(attempt).rejects.toBeInstanceOf(CapacityError);
    await expect(attempt).rejects.toThrow(
      "Storage is 100% full and no more old podcast audio can be removed — raise STORAGE_LIMIT_BYTES or lower KEEP_RECENT_AUDIO"
    );
    expect(removedPaths()).toEqual(["u2/b1/brief.mp3", "u1/a1/brief.mp3", "u1/a2/brief.mp3"]);
  });

  it("with AUTO_PRUNE_AUDIO off, refuses without pruning anything", async () => {
    vi.stubEnv("AUTO_PRUNE_AUDIO", "off");
    install(twoPeopleProject(190 * MB)); // 890 MB
    const attempt = ensureRoomFor(20 * MB);
    await expect(attempt).rejects.toBeInstanceOf(CapacityError);
    await expect(attempt).rejects.toThrow(
      "Storage is 89% full, too full for this brief's audio — remove old podcast audio under Previous briefs, or raise STORAGE_LIMIT_BYTES"
    );
    expect(fake.removals).toEqual([]);
    expect(fake.tables.episodes.filter((r) => r.audio_pruned_at)).toEqual([row("gone")]);
  });

  it("when usage can't be measured, logs and lets the file through", async () => {
    install(twoPeopleProject(600 * MB));
    delete fake.functions.storage_usage_bytes; // e.g. the capacity migration isn't applied yet
    await expect(ensureRoomFor(20 * MB)).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith("Capacity check skipped:", expect.any(Error));
    expect(fake.removals).toEqual([]);
  });

  it("a mistyped limit skips the check rather than pruning against the 1 GiB default", async () => {
    vi.stubEnv("STORAGE_LIMIT_BYTES", "100GB");
    install(twoPeopleProject(600 * MB)); // 1300 MB: far past the default's 90%
    await expect(ensureRoomFor(20 * MB)).resolves.toBeUndefined();
    expect(fake.removals).toEqual([]);
  });
});
