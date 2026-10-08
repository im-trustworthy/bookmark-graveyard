import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appliedVersions,
  applySqlFor,
  checkElevenLabsKey,
  checkRequired,
  checkXaiKey,
  dollarQuoteTag,
  fillMissingSecrets,
  freshSetupSql,
  GENERATED_SECRETS,
  keyVerdict,
  migrateWithToken,
  optionalStatus,
  parseEnvFile,
  pendingMigrations,
  placeholderValues,
  projectRefFromUrl,
  readMigrations,
  REQUIRED,
  runSql,
  supabaseGet,
  supabaseHeaders,
  TRACKING_TABLE_SQL,
} from "../../../scripts/setup.mjs";

// Everything here is offline: fetch is stubbed per test, and files live in a temp dir.
const MIGRATIONS_DIR = fileURLToPath(new URL("../../../supabase/migrations", import.meta.url));
const REF = "abcdefghijklmnopqrst";
const HEX64 = /^[0-9a-f]{64}$/;

type Migration = { version: string; name: string; sql: string };
const migration = (version: string, name = `m${version}`, sql = `create table t${version} ();`): Migration => ({
  version,
  name,
  sql,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => handler(String(input), init));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The `query` of every Management API call, in order. */
const sentQueries = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls.map(([, init]) => (JSON.parse(String(init?.body)) as { query: string }).query);

/**
 * What Postgres reads as the `statements` element of a migration's history row:
 * from `array[$tag$` to the first closing `$tag$` after it, which is where its
 * lexer ends a dollar-quoted literal. Also checks the literal closes the array.
 */
function statementLiteral(sql: string, version: string): string {
  const insertAt = sql.indexOf(`values ('${version}'`);
  expect(insertAt).toBeGreaterThan(-1);
  const open = sql.slice(insertAt).match(/array\[(\$mig\d*\$)/);
  if (!open || open.index === undefined) throw new Error(`no dollar-quoted literal for ${version}`);
  const tag = open[1];
  const start = insertAt + open.index + open[0].length;
  const end = sql.indexOf(tag, start);
  expect(sql.slice(end, end + tag.length + 3)).toBe(`${tag}]);`);
  return sql.slice(start, end);
}

let tempDirs: string[] = [];
function tempDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "setup-script-test-"));
  tempDirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("parseEnvFile", () => {
  it("skips blank lines and comments, and keeps = inside values", () => {
    const text = [
      "# Supabase",
      "",
      "NEXT_PUBLIC_SUPABASE_URL=https://abc.supabase.co",
      "   ",
      "SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0=.c2ln==",
      "DATABASE_URL=postgres://u:p@host/db?sslmode=require&x=1",
      "# APP_URL=http://commented.out",
      "EMPTY=",
    ].join("\n");
    expect(parseEnvFile(text)).toEqual({
      NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0=.c2ln==",
      DATABASE_URL: "postgres://u:p@host/db?sslmode=require&x=1",
      EMPTY: "",
    });
  });

  it("strips matching quotes, and a quoted value may contain # and =", () => {
    const vars = parseEnvFile(
      [
        'DOUBLE="has # and = inside" # trailing comment',
        "SINGLE='single quoted'",
        "BACKTICK=`back ticked`",
        'NEWLINE="line one\\nline two"',
        "LITERAL='no \\n expansion'",
        'UNTERMINATED="half',
      ].join("\n")
    );
    expect(vars).toEqual({
      DOUBLE: "has # and = inside",
      SINGLE: "single quoted",
      BACKTICK: "back ticked",
      NEWLINE: "line one\nline two",
      LITERAL: "no \\n expansion",
      UNTERMINATED: '"half',
    });
  });

  it("reads lines like Next.js does: inline comments, export, spaces, CRLF, last one wins", () => {
    const vars = parseEnvFile(
      ["XAI_API_KEY=xai-abc # my key", "export X_CLIENT_ID=client", "APP_URL = http://localhost:3000 ", "CR=value\r", "DUP=first", "DUP=second"].join(
        "\n"
      )
    );
    expect(vars).toEqual({
      XAI_API_KEY: "xai-abc",
      X_CLIENT_ID: "client",
      APP_URL: "http://localhost:3000",
      CR: "value",
      DUP: "second",
    });
  });
});

describe("placeholder detection", () => {
  const example = [
    "# Bookmark Brief — environment variables",
    "NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co",
    "XAI_API_KEY=your-xai-api-key",
    "# ELEVENLABS_API_KEY=your-elevenlabs-api-key",
    "#   GROK_VOICE_HOST_A=ara",
    "# Comma-separated X user IDs allowed to log in (empty = personal mode)",
    "APP_ENCRYPTION_KEY=",
    "APP_URL=http://localhost:3000",
  ].join("\n");

  it("collects the example's values, commented-out ones included, and skips blanks and prose", () => {
    expect(placeholderValues(example)).toEqual({
      NEXT_PUBLIC_SUPABASE_URL: "https://your-project-ref.supabase.co",
      XAI_API_KEY: "your-xai-api-key",
      ELEVENLABS_API_KEY: "your-elevenlabs-api-key",
      GROK_VOICE_HOST_A: "ara",
      APP_URL: "http://localhost:3000",
    });
  });

  it("counts a required value still equal to its placeholder as missing", () => {
    const env = {
      NEXT_PUBLIC_SUPABASE_URL: "https://your-project-ref.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service",
      X_CLIENT_ID: "id",
      X_CLIENT_SECRET: "",
      XAI_API_KEY: "xai-real",
      APP_ENCRYPTION_KEY: "not-hex",
    };
    expect(checkRequired(env, placeholderValues(example))).toEqual([
      ["NEXT_PUBLIC_SUPABASE_URL", "still the .env.example placeholder"],
      ["SUPABASE_SERVICE_ROLE_KEY", ""],
      ["X_CLIENT_ID", ""],
      ["X_CLIENT_SECRET", "missing"],
      ["XAI_API_KEY", ""],
      ["APP_ENCRYPTION_KEY", "must be 64 hex characters (32 bytes)"],
      ["SESSION_SECRET", "missing"],
    ]);
  });

  it("needs only the URL and service-role key from Supabase, and ignores a leftover anon key", () => {
    expect([...REQUIRED, ...GENERATED_SECRETS]).toEqual([
      "NEXT_PUBLIC_SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "X_CLIENT_ID",
      "X_CLIENT_SECRET",
      "XAI_API_KEY",
      "APP_ENCRYPTION_KEY",
      "SESSION_SECRET",
    ]);
    // Older .env.example files had it, but the app never reads it: no row, required or optional.
    const env = { NEXT_PUBLIC_SUPABASE_ANON_KEY: "leftover-anon-key" };
    const names = [...checkRequired(env, {}).map(([name]) => name), ...optionalStatus(env, {}).map(([, name]) => name)];
    expect(names).toEqual(expect.arrayContaining(["SUPABASE_SERVICE_ROLE_KEY", "ELEVENLABS_API_KEY"]));
    expect(names).not.toContain("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  });

  it("flags an uncommented ElevenLabs placeholder but not a real default that matches the example", () => {
    const rows = optionalStatus(
      { ELEVENLABS_API_KEY: "your-elevenlabs-api-key", GROK_VOICE_HOST_A: "ara" },
      placeholderValues(example)
    );
    expect(rows).toContainEqual(["✗", "ELEVENLABS_API_KEY", "still the .env.example placeholder (warning)"]);
    expect(rows).toContainEqual(["✓", "GROK_VOICE_HOST_A", "ara"]);
  });
});

describe("optionalStatus", () => {
  const status = (env: Record<string, string | undefined>) =>
    Object.fromEntries(optionalStatus(env, {}).map(([marker, name, note]) => [name, `${marker} ${note}`]));

  it("explains the voice provider the app will pick, like chooseProvider()", () => {
    expect(status({ ELEVENLABS_API_KEY: "sk_x" }).VOICE_PROVIDER).toBe("– not set: elevenlabs, because ELEVENLABS_API_KEY is set");
    expect(status({}).VOICE_PROVIDER).toBe("– not set: grok");
    expect(status({ VOICE_PROVIDER: " Grok " }).VOICE_PROVIDER).toBe("✓ grok");
    expect(status({ VOICE_PROVIDER: "openai" }).VOICE_PROVIDER).toMatch(/^✗ "openai" is not grok or elevenlabs/);
  });

  it("warns about an APP_URL that would break the X callback URL", () => {
    expect(status({}).APP_URL).toBe("– not set: http://localhost:3000");
    expect(status({ APP_URL: "" }).APP_URL).toMatch(/^✗ blank/);
    expect(status({ APP_URL: "https://x.example/" }).APP_URL).toMatch(/^✗ .*"\/\/"/);
    expect(status({ APP_URL: "https://x.example" }).APP_URL).toBe("✓ https://x.example");
  });

  it("counts allowlisted IDs and never shows a key's value", () => {
    const rows = optionalStatus(
      { ALLOWED_X_USER_IDS: "123, 456,,", CRON_SECRET: "cron-secret-value", ELEVENLABS_API_KEY: "sk_secret_value" },
      {}
    );
    expect(rows).toContainEqual(["✓", "ALLOWED_X_USER_IDS", "2 X user IDs"]);
    expect(rows).toContainEqual(["✓", "CRON_SECRET", "set"]);
    expect(JSON.stringify(rows)).not.toMatch(/cron-secret-value|sk_secret_value/);
  });
});

describe("fillMissingSecrets", () => {
  it("fills blank secrets in place and leaves every other line byte-for-byte", () => {
    const before = [
      "# --- App secrets ---",
      "XAI_API_KEY=xai-123",
      "APP_ENCRYPTION_KEY=",
      "# HMAC key for the session cookie",
      "SESSION_SECRET=",
      "APP_URL=http://localhost:3000",
      "",
    ].join("\n");
    const { text, generated } = fillMissingSecrets(before);
    expect(generated).toEqual(["APP_ENCRYPTION_KEY", "SESSION_SECRET"]);

    const oldLines = before.split("\n");
    const newLines = text.split("\n");
    expect(newLines).toHaveLength(oldLines.length);
    newLines.forEach((line, i) => {
      if (i === 2) expect(line).toMatch(/^APP_ENCRYPTION_KEY=[0-9a-f]{64}$/);
      else if (i === 4) expect(line).toMatch(/^SESSION_SECRET=[0-9a-f]{64}$/);
      else expect(line).toBe(oldLines[i]);
    });
    const vars = parseEnvFile(text);
    expect(vars.APP_ENCRYPTION_KEY).not.toBe(vars.SESSION_SECRET);
  });

  it("appends absent secrets, ending an unterminated last line first", () => {
    const { text, generated } = fillMissingSecrets("XAI_API_KEY=xai-123");
    expect(generated).toEqual(["APP_ENCRYPTION_KEY", "SESSION_SECRET"]);
    expect(text.startsWith("XAI_API_KEY=xai-123\n")).toBe(true);
    expect(text).toMatch(/\nAPP_ENCRYPTION_KEY=[0-9a-f]{64}\nSESSION_SECRET=[0-9a-f]{64}\n$/);

    expect(fillMissingSecrets("").text).toMatch(/^APP_ENCRYPTION_KEY=[0-9a-f]{64}\nSESSION_SECRET=[0-9a-f]{64}\n$/);
  });

  it("keeps CRLF line endings, export prefixes and spacing", () => {
    const { text } = fillMissingSecrets('A=1\r\nexport APP_ENCRYPTION_KEY=\r\nB = 2\r\n');
    const lines = text.split("\r\n");
    expect(lines[0]).toBe("A=1");
    expect(lines[1]).toMatch(/^export APP_ENCRYPTION_KEY=[0-9a-f]{64}$/);
    expect(lines[2]).toBe("B = 2");
    expect(lines[3]).toMatch(/^SESSION_SECRET=[0-9a-f]{64}$/);
    expect(lines[4]).toBe("");
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");

    const spaced = fillMissingSecrets('SESSION_SECRET = ""   # fill me', ["SESSION_SECRET"]).text;
    expect(spaced).toMatch(/^SESSION_SECRET = [0-9a-f]{64}$/);
  });

  it("leaves a complete file untouched and never replaces a set value, even an invalid one", () => {
    const complete = `APP_ENCRYPTION_KEY=${"ab".repeat(32)}\nSESSION_SECRET=s3cret\n`;
    expect(fillMissingSecrets(complete)).toEqual({ text: complete, generated: [] });

    const invalid = "APP_ENCRYPTION_KEY=too-short\nSESSION_SECRET=x";
    expect(fillMissingSecrets(invalid)).toEqual({ text: invalid, generated: [] });
  });

  it("fills the last occurrence (the one that takes effect) and only the names asked for", () => {
    const { text, generated } = fillMissingSecrets("APP_ENCRYPTION_KEY=old\nAPP_ENCRYPTION_KEY=\n", ["APP_ENCRYPTION_KEY"]);
    expect(generated).toEqual(["APP_ENCRYPTION_KEY"]);
    const [first, second] = text.split("\n");
    expect(first).toBe("APP_ENCRYPTION_KEY=old");
    expect(parseEnvFile(text).APP_ENCRYPTION_KEY).toMatch(HEX64);
    expect(second).toMatch(/^APP_ENCRYPTION_KEY=/);
    expect(text).not.toContain("SESSION_SECRET");
  });
});

describe("projectRefFromUrl", () => {
  it("takes the ref from a hosted project URL only", () => {
    expect(projectRefFromUrl("https://abcdefghijklmnopqrst.supabase.co")).toBe(REF);
    expect(projectRefFromUrl("https://abcdefghijklmnopqrst.supabase.co/")).toBe(REF);
    expect(projectRefFromUrl("https://your-project-ref.supabase.co")).toBeNull();
    expect(projectRefFromUrl("http://abcdefghijklmnopqrst.supabase.co")).toBeNull();
    expect(projectRefFromUrl("http://127.0.0.1:54321")).toBeNull();
    expect(projectRefFromUrl("not a url")).toBeNull();
    expect(projectRefFromUrl(undefined)).toBeNull();
  });
});

describe("migrations on disk", () => {
  it("sorts by version numerically, strips a BOM and ignores other files", () => {
    const dir = tempDir({
      "20261007164201_episode_voice.sql": "select 2;",
      "20260709015653_initial_schema.sql": "\uFEFFselect 1;",
      "10_ten.sql": "select 10;",
      "9_nine.sql": "select 9;",
      "notes.sql": "not a migration",
      "README.md": "# readme",
    });
    const all = readMigrations(dir);
    expect(all.map((m) => `${m.version}_${m.name}`)).toEqual([
      "9_nine",
      "10_ten",
      "20260709015653_initial_schema",
      "20261007164201_episode_voice",
    ]);
    expect(all[2].sql).toBe("select 1;");
  });

  it("refuses two files with the same version", () => {
    const dir = tempDir({ "1_a.sql": "select 1;", "1_b.sql": "select 1;" });
    expect(() => readMigrations(dir)).toThrow(/share version 1/);
  });

  it("reads every file in supabase/migrations, in order", () => {
    const all = readMigrations(MIGRATIONS_DIR);
    expect(all).toHaveLength(readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).length);
    const versions = all.map((m) => m.version);
    expect(versions).toEqual([...versions].sort());
    expect(all[0].sql).toContain("insert into storage.buckets");
  });

  it("computes pending migrations by version, keeping their order", () => {
    const all = [migration("1"), migration("2"), migration("3")];
    expect(pendingMigrations(all, ["2"]).map((m) => m.version)).toEqual(["1", "3"]);
    expect(pendingMigrations(all, new Set(["1", "2", "3"]))).toEqual([]);
    expect(pendingMigrations(all, ["99"])).toEqual(all);
    expect(pendingMigrations(all, [])).toEqual(all);
  });
});

describe("migration SQL", () => {
  it("picks a dollar-quote tag that never occurs in the text, even across its end", () => {
    expect(dollarQuoteTag("select 1;")).toBe("$mig$");
    expect(dollarQuoteTag("select $$ x $$;")).toBe("$mig$");
    expect(dollarQuoteTag("select '$mig$';")).toBe("$mig1$");
    expect(dollarQuoteTag("select '$mig$', '$mig1$';")).toBe("$mig2$");
    // "...$mig" + "$mig$" would close the literal one character early.
    expect(dollarQuoteTag("-- ends in $mig")).toBe("$mig1$");
    expect(dollarQuoteTag("-- ends in $")).toBe("$mig$");
  });

  it("wraps one migration and its history row in one transaction", () => {
    const sql = [
      "create function f() returns text language sql as $$ select 'it''s {a,\"b\"} \\ $mig$ $mig1$' $$;",
      "-- a last line comment with no newline, ending in $mig",
    ].join("\n");
    const m = migration("20261007164201", "o'brien", sql);
    const wrapped = applySqlFor(m);

    expect(wrapped.startsWith(`begin;\n${sql}\n;\n`)).toBe(true);
    expect(wrapped.endsWith("\ncommit;")).toBe(true);
    expect(wrapped).toContain(
      "insert into supabase_migrations.schema_migrations (version, name, statements) values ('20261007164201', 'o''brien', array[$mig2$"
    );
    expect(statementLiteral(wrapped, m.version)).toBe(sql);
  });

  it("writes every real migration, in order, as one transaction for a fresh project", () => {
    const all = readMigrations(MIGRATIONS_DIR);
    const sql = freshSetupSql(all);

    expect(sql.match(/^begin;$/gm)).toHaveLength(1);
    expect(sql.trimEnd().endsWith("\ncommit;")).toBe(true);
    const trackingAt = sql.indexOf(TRACKING_TABLE_SQL);
    expect(trackingAt).toBeGreaterThan(sql.indexOf("begin;"));

    let previous = trackingAt;
    for (const m of all) {
      const at = sql.indexOf(`values ('${m.version}', '${m.name}'`);
      expect(at).toBeGreaterThan(previous);
      expect(sql.lastIndexOf(m.sql, at)).toBeGreaterThan(previous);
      expect(statementLiteral(sql, m.version)).toBe(m.sql);
      previous = at;
    }
  });
});

describe("Management API", () => {
  it("POSTs the query to /v1/projects/{ref}/database/query with the access token", async () => {
    const fetchMock = stubFetch(() => json([{ one: 1 }], 201));
    await expect(runSql(REF, "sbp_test_token", "select 1 as one;")).resolves.toEqual([{ one: 1 }]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.supabase.com/v1/projects/${REF}/database/query`);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ Authorization: "Bearer sbp_test_token", "Content-Type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({ query: "select 1 as one;" });
  });

  it("turns errors into messages that never include the token", async () => {
    stubFetch(() => json({ message: "JWT could not be decoded" }, 401));
    const rejected = runSql(REF, "sbp_test_token", "select 1;");
    await expect(rejected).rejects.toThrow(/SUPABASE_ACCESS_TOKEN was rejected \(401: JWT could not be decoded\).*account\/tokens/);
    await expect(rejected).rejects.not.toThrow(/sbp_test_token/);

    stubFetch(() => json({ message: 'Failed to run sql query: ERROR:  42P07: relation "users" already exists' }, 400));
    await expect(runSql(REF, "sbp_test_token", "create table users ();")).rejects.toThrow(
      /Management API 400: Failed to run sql query: .*already exists/
    );

    stubFetch(() => new Response("", { status: 201 }));
    await expect(runSql(REF, "sbp_test_token", "begin; commit;")).resolves.toEqual([]);
  });

  it("reads applied versions without writing, and none when history isn't tracked yet", async () => {
    let fetchMock = stubFetch(() => json([{ tracked: false }], 201));
    await expect(appliedVersions(REF, "sbp_test_token")).resolves.toEqual([]);
    expect(sentQueries(fetchMock)).toEqual([
      "select to_regclass('supabase_migrations.schema_migrations') is not null as tracked;",
    ]);

    fetchMock = stubFetch((_url, init) =>
      String(init?.body).includes("to_regclass")
        ? json([{ tracked: true }], 201)
        : json([{ version: "20260709015653" }, { version: "20260709025518" }], 201)
    );
    await expect(appliedVersions(REF, "sbp_test_token")).resolves.toEqual(["20260709015653", "20260709025518"]);
    expect(sentQueries(fetchMock)[1]).toBe("select version from supabase_migrations.schema_migrations order by version;");
  });
});

describe("migrateWithToken", () => {
  const migrations = [migration("1"), migration("2"), migration("3")];

  /** A fake project with `applied` recorded; a query containing `failOn` fails like a SQL error. */
  function fakeProject(applied: string[], failOn?: string) {
    return stubFetch((_url, init) => {
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      if (query.includes("to_regclass")) return json([{ tracked: applied.length > 0 }], 201);
      if (query.startsWith("select version")) return json(applied.map((version) => ({ version })), 201);
      if (failOn && query.includes(failOn)) return json({ message: "Failed to run sql query: ERROR:  boom" }, 400);
      return json([], 201);
    });
  }

  function run(confirmAnswer: boolean) {
    const log: string[] = [];
    const confirm = vi.fn(async () => confirmAnswer);
    const result = migrateWithToken({ ref: REF, token: "sbp_test_token", migrations, confirm, log: (line) => log.push(line) });
    return { result, log, confirm };
  }

  it("only reads when the database is up to date, and mentions versions it doesn't know", async () => {
    const fetchMock = fakeProject(["1", "2", "3", "999"]);
    const { result, log, confirm } = run(true);
    await expect(result).resolves.toEqual({ ok: true, applied: 0 });
    expect(confirm).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(log.join("\n")).toContain("database already up to date (3/3)");
    expect(log.join("\n")).toMatch(/1 version not in supabase\/migrations.*999/);
  });

  it("asks, then creates the history table and applies each pending migration in order", async () => {
    const fetchMock = fakeProject(["1"]);
    const { result, log, confirm } = run(true);
    await expect(result).resolves.toEqual({ ok: true, applied: 2 });
    expect(confirm).toHaveBeenCalledWith(`Apply 2 pending migrations to ${REF}? [y/N] `);
    expect(sentQueries(fetchMock).slice(2)).toEqual([TRACKING_TABLE_SQL, applySqlFor(migrations[1]), applySqlFor(migrations[2])]);
    expect(log).toContain("  ✓ applied 2 migrations");
  });

  it("writes nothing when the answer is no", async () => {
    const fetchMock = fakeProject(["1"]);
    const { result, log } = run(false);
    await expect(result).resolves.toEqual({ ok: false, applied: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(log).toContain("  ✗ not applied: 2 migrations still pending");
  });

  it("stops at the first failing migration", async () => {
    const fetchMock = fakeProject([], "create table t2");
    const { result, log } = run(true);
    await expect(result).resolves.toEqual({ ok: false, applied: 1 });
    const queries = sentQueries(fetchMock);
    expect(queries).toHaveLength(4); // probe, history table, migration 1, migration 2
    expect(queries.some((query) => query.includes("create table t3"))).toBe(false);
    expect(log.join("\n")).toMatch(/✗ 2_m2: Management API 400: Failed to run sql query: ERROR: {2}boom/);
  });
});

describe("Supabase and vendor checks", () => {
  it("puts legacy JWT keys on Authorization too, but new sb_secret_ keys only on apikey", () => {
    expect(supabaseHeaders("eyJhbGciOi.payload.sig")).toEqual({
      apikey: "eyJhbGciOi.payload.sig",
      Authorization: "Bearer eyJhbGciOi.payload.sig",
    });
    expect(supabaseHeaders("sb_secret_abc")).toEqual({ apikey: "sb_secret_abc" });
  });

  it("probes Supabase with the service-role key", async () => {
    const fetchMock = stubFetch(() => json([], 200));
    await expect(supabaseGet("https://abc.supabase.co/rest/v1/users?select=id&limit=0", "sb_secret_abc")).resolves.toEqual({
      status: 200,
      body: "[]",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://abc.supabase.co/rest/v1/users?select=id&limit=0");
    expect(init?.headers).toEqual({ apikey: "sb_secret_abc" });
  });

  it("reads key checks like the app does", () => {
    expect(keyVerdict(200, "{}")).toBe("ok");
    expect(keyVerdict(401, "")).toBe("invalid");
    expect(keyVerdict(403, "")).toBe("invalid");
    expect(keyVerdict(400, '{"error":"Incorrect API key provided."}')).toBe("invalid");
    expect(keyVerdict(400, "bad request")).toBe("unknown");
    expect(keyVerdict(429, "slow down")).toBe("unknown");
    expect(keyVerdict(503, "")).toBe("unknown");
  });

  it("checks the xAI key with a free model list call", async () => {
    const fetchMock = stubFetch(() => json({ code: "invalid-argument", error: "Incorrect API key provided." }, 400));
    await expect(checkXaiKey("xai-test")).resolves.toEqual({ verdict: "invalid", detail: "400: Incorrect API key provided." });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.x.ai/v1/models");
    expect(init?.headers).toEqual({ Authorization: "Bearer xai-test" });
  });

  it("checks the ElevenLabs key with a free voice list call", async () => {
    const fetchMock = stubFetch(() =>
      json({ detail: { status: "invalid_api_key", message: "Invalid API key" } }, 401)
    );
    await expect(checkElevenLabsKey("sk_test")).resolves.toEqual({ verdict: "invalid", detail: "401: Invalid API key" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.elevenlabs.io/v1/voices");
    expect(init?.headers).toEqual({ "xi-api-key": "sk_test" });
  });

  it("calls an unreachable vendor unverified rather than invalid", async () => {
    stubFetch(() => {
      throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
    });
    await expect(checkXaiKey("xai-test")).resolves.toEqual({ verdict: "unknown", detail: "fetch failed (ENOTFOUND)" });
  });
});
