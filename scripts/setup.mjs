#!/usr/bin/env node
/**
 * One-command setup for a self-hosted Bookmark Graveyard: `npm run setup`.
 *
 *   1. Loads .env.local, creating it from .env.example on the first run.
 *   2. Checks the variables the app needs, and generates APP_ENCRYPTION_KEY and
 *      SESSION_SECRET into .env.local when they are blank.
 *   3. Provisions the Supabase database from supabase/migrations/*.sql, the
 *      schema's source of truth:
 *      - with SUPABASE_ACCESS_TOKEN (a personal access token, the variable the
 *        Supabase CLI reads) it applies the pending migrations through the
 *        Management API and records each one in
 *        supabase_migrations.schema_migrations exactly like `supabase db push`,
 *        so either tool can take over from the other;
 *      - without a token it can't see what a project already has, so it writes
 *        the whole schema as one SQL file for a brand-new project's SQL editor.
 *   4. Verifies the schema and the private `episodes` bucket with the
 *      service-role key.
 *   5. Checks the xAI key (and the ElevenLabs key, if set) with free calls.
 *
 * Flags: --check  read-only: writes no files and never touches the database
 *        --yes    apply pending migrations without asking first
 *
 * Exits 1 when a required variable is missing or rejected, or a database step
 * fails. Zero dependencies (Node 20+ fetch). Secret values are never printed.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = join(ROOT, ".env.local");
const EXAMPLE_FILE = join(ROOT, ".env.example");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");
const MANAGEMENT_API = "https://api.supabase.com/v1";
const TOKENS_PAGE = "https://supabase.com/dashboard/account/tokens";
const DEFAULT_APP_URL = "http://localhost:3000";

/**
 * Variables the app can't run without. No Supabase anon key: only the server
 * talks to Supabase, with the service-role key, so a leftover
 * NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local is simply ignored.
 */
export const REQUIRED = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "X_CLIENT_ID",
  "X_CLIENT_SECRET",
  "XAI_API_KEY",
];

/** Also required, but only random bytes, so setup generates them when blank. */
export const GENERATED_SECRETS = ["APP_ENCRYPTION_KEY", "SESSION_SECRET"];

const OPTIONAL = [
  "VOICE_PROVIDER",
  "GROK_VOICE_HOST_A",
  "GROK_VOICE_HOST_B",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_VOICE_HOST_A",
  "ELEVENLABS_VOICE_HOST_B",
  "APP_URL",
  "ALLOWED_X_USER_IDS",
  "CRON_SECRET",
];

// Values that go to an API; masked in all output in case an error body ever echoes one.
const SECRET_NAMES = [
  ...REQUIRED.filter((name) => name !== "NEXT_PUBLIC_SUPABASE_URL"),
  ...GENERATED_SECRETS,
  "ELEVENLABS_API_KEY",
  "CRON_SECRET",
  "SUPABASE_ACCESS_TOKEN",
];
const secrets = new Set();

/** console.log, except that any secret value in the line comes out masked. */
function say(line = "") {
  let out = line;
  for (const secret of secrets) out = out.split(secret).join("<redacted>");
  console.log(out);
}

function heading(title) {
  say();
  say(title);
}

function row(marker, name, note = "") {
  return `  ${marker} ${name.padEnd(30)} ${note}`.trimEnd();
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------- .env files

const QUOTED_VALUE = /^(?:'(?:\\'|[^'])*'|"(?:\\"|[^"])*"|`(?:\\`|[^`])*`)(?=\s*(?:#.*)?$)/;

/**
 * Parses one .env line the way Next.js does (it bundles dotenv): optional
 * `export`, spaces around `=`, a quoted value may hold `#` and loses its quotes
 * ("double" quotes also expand \n), and an unquoted value ends at `#`. Returns
 * [key, value], or null for blank lines, comments and anything else.
 * @param {string} line
 * @returns {[string, string] | null}
 */
export function parseEnvLine(line) {
  const m = line.replace(/\r$/, "").match(/^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/);
  if (!m) return null;
  let value = (m[2].match(QUOTED_VALUE)?.[0] ?? m[2].split("#")[0]).trim();
  const quote = value[0];
  if (value.length > 1 && /["'`]/.test(quote) && value.endsWith(quote)) value = value.slice(1, -1);
  if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
  return [m[1], value];
}

/**
 * KEY=value pairs of a .env file; a key repeated later wins, as in dotenv.
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnvFile(text) {
  /** @type {Record<string, string>} */
  const vars = {};
  for (const line of text.split("\n")) {
    const entry = parseEnvLine(line);
    if (entry) vars[entry[0]] = entry[1];
  }
  return vars;
}

/**
 * The values .env.example ships with, by variable. Commented-out examples like
 * `# ELEVENLABS_API_KEY=your-elevenlabs-api-key` count too: uncommenting one
 * without editing it is the usual mistake. Blank values are left out.
 * @param {string} exampleText
 * @returns {Record<string, string>}
 */
export function placeholderValues(exampleText) {
  /** @type {Record<string, string>} */
  const values = {};
  for (const line of exampleText.split("\n")) {
    const entry = parseEnvLine(line.replace(/^\s*#\s*(?=[A-Z][A-Z0-9_]*=)/, ""));
    if (entry?.[1]) values[entry[0]] = entry[1];
  }
  return values;
}

/**
 * Fills blank or absent secrets (APP_ENCRYPTION_KEY, SESSION_SECRET) with 32
 * random bytes of hex. Only that line changes, or one is appended, so every
 * other byte of the file stays as it was. A value that is set is never
 * replaced: APP_ENCRYPTION_KEY is what decrypts the tokens already stored.
 * @param {string} envText
 * @param {string[]} [names]
 * @returns {{ text: string, generated: string[] }}
 */
export function fillMissingSecrets(envText, names = GENERATED_SECRETS) {
  let text = envText;
  /** @type {string[]} */
  const generated = [];
  for (const name of names) {
    const lines = text.split("\n");
    const at = lines.findLastIndex((line) => parseEnvLine(line)?.[0] === name);
    if (at !== -1 && parseEnvLine(lines[at])?.[1]) continue;
    const secret = randomBytes(32).toString("hex");
    if (at === -1) {
      const eol = text.includes("\r\n") ? "\r\n" : "\n";
      text += `${text && !text.endsWith("\n") ? eol : ""}${name}=${secret}${eol}`;
    } else {
      // Keep the line's own `export`, spacing and CRLF; only the value changes.
      lines[at] = lines[at].replace(/^(\s*(?:export\s+)?[\w.-]+\s*=[ \t]*).*?(\r?)$/, `$1${secret}$2`);
      text = lines.join("\n");
    }
    generated.push(name);
  }
  return { text, generated };
}

/**
 * [name, problem] for each required variable; problem is "" when it's fine. A
 * value still equal to the .env.example placeholder counts as missing.
 * @param {Record<string, string | undefined>} env
 * @param {Record<string, string>} placeholders
 * @returns {[string, string][]}
 */
export function checkRequired(env, placeholders) {
  return [...REQUIRED, ...GENERATED_SECRETS].map((name) => {
    const value = env[name];
    if (!value) return [name, "missing"];
    if (value === placeholders[name]) return [name, "still the .env.example placeholder"];
    // crypto.ts reads it as hex for AES-256: anything else is a wrong-length key.
    if (name === "APP_ENCRYPTION_KEY" && !/^[0-9a-f]{64}$/i.test(value)) {
      return [name, "must be 64 hex characters (32 bytes)"];
    }
    return [name, ""];
  });
}

/**
 * [marker, name, note] for each optional variable. Only non-secret values are
 * shown; keys are reported as "set".
 * @param {Record<string, string | undefined>} env
 * @param {Record<string, string>} placeholders
 * @returns {[string, string, string][]}
 */
export function optionalStatus(env, placeholders) {
  const isPlaceholder = (name) => Boolean(env[name]) && env[name] === placeholders[name];
  /** @returns {[string, string, string]} */
  const hidden = (name, unsetNote = "not set") =>
    isPlaceholder(name)
      ? ["✗", name, "still the .env.example placeholder (warning)"]
      : env[name]
        ? ["✓", name, "set"]
        : ["–", name, unsetNote];
  /** @returns {[string, string, string]} */
  const shown = (name, unsetNote) => (env[name] ? ["✓", name, String(env[name])] : ["–", name, unsetNote]);

  // Same rule as chooseProvider() in src/lib/voice/index.ts.
  const provider = env.VOICE_PROVIDER?.trim().toLowerCase();
  /** @type {[string, string, string]} */
  const providerRow = !provider
    ? ["–", "VOICE_PROVIDER", `not set: ${env.ELEVENLABS_API_KEY ? "elevenlabs, because ELEVENLABS_API_KEY is set" : "grok"}`]
    : provider === "grok" || provider === "elevenlabs"
      ? ["✓", "VOICE_PROVIDER", provider]
      : ["✗", "VOICE_PROVIDER", `"${env.VOICE_PROVIDER}" is not grok or elevenlabs, so audio briefs fail (warning)`];

  const allowed = (env.ALLOWED_X_USER_IDS ?? "").split(",").filter((id) => id.trim());
  return [
    providerRow,
    shown("GROK_VOICE_HOST_A", "not set: ara"),
    shown("GROK_VOICE_HOST_B", "not set: helios"),
    hidden("ELEVENLABS_API_KEY"),
    hidden("ELEVENLABS_VOICE_HOST_A"),
    hidden("ELEVENLABS_VOICE_HOST_B"),
    appUrlStatus(env.APP_URL),
    allowed.length
      ? ["✓", "ALLOWED_X_USER_IDS", plural(allowed.length, "X user ID")]
      : ["–", "ALLOWED_X_USER_IDS", "empty: personal mode (whoever signs in with X is allowed)"],
    hidden("CRON_SECRET", "not set: /api/cron/sync stays disabled"),
  ];
}

/**
 * The app builds its X callback URL as `${APP_URL}/api/auth/callback/x`.
 * @param {string | undefined} value
 * @returns {[string, string, string]}
 */
function appUrlStatus(value) {
  if (value === undefined) return ["–", "APP_URL", `not set: ${DEFAULT_APP_URL}`];
  if (!value) return ["✗", "APP_URL", `blank, which breaks the X callback URL; set it, e.g. ${DEFAULT_APP_URL} (warning)`];
  if (value.endsWith("/")) return ["✗", "APP_URL", `${value} ends in "/", so the X callback URL gets "//" (warning)`];
  return ["✓", "APP_URL", value];
}

/**
 * "abcdefghijklmnopqrst" from https://abcdefghijklmnopqrst.supabase.co; null for
 * anything else (custom domain, self-hosted, a placeholder).
 * @param {string | undefined} url
 * @returns {string | null}
 */
export function projectRefFromUrl(url) {
  try {
    const { protocol, hostname } = new URL(String(url));
    const m = hostname.match(/^([a-z0-9]+)\.supabase\.co$/);
    return protocol === "https:" && m ? m[1] : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- migrations

/** @typedef {{ version: string, name: string, sql: string }} Migration */

/**
 * supabase/migrations/<version>_<name>.sql, sorted by version. That's the
 * Supabase CLI's naming, so `supabase db push` and this script agree on what
 * each version is. Other files are ignored, like the CLI does.
 * @param {string} dir
 * @returns {Migration[]}
 */
export function readMigrations(dir) {
  const migrations = readdirSync(dir).flatMap((file) => {
    const m = file.match(/^(\d+)_(.+)\.sql$/);
    if (!m) return [];
    const sql = readFileSync(join(dir, file), "utf8").replace(/^\uFEFF/, "");
    return [{ version: m[1], name: m[2], sql }];
  });
  // Numeric rather than by filename, in case versions ever differ in length.
  migrations.sort((a, b) => (BigInt(a.version) < BigInt(b.version) ? -1 : BigInt(a.version) > BigInt(b.version) ? 1 : 0));
  migrations.forEach((m, i) => {
    if (i && m.version === migrations[i - 1].version) throw new Error(`Two migrations share version ${m.version}`);
  });
  return migrations;
}

/**
 * The migrations whose version isn't recorded yet, still in version order.
 * @param {Migration[]} all
 * @param {Iterable<string>} appliedVersions
 * @returns {Migration[]}
 */
export function pendingMigrations(all, appliedVersions) {
  const applied = new Set(appliedVersions);
  return all.filter((m) => !applied.has(m.version));
}

// The Supabase CLI's own DDL for its history table, so either tool can create it first.
export const TRACKING_TABLE_SQL = [
  "create schema if not exists supabase_migrations;",
  "create table if not exists supabase_migrations.schema_migrations (version text not null primary key, statements text[], name text);",
].join("\n");

/**
 * A dollar-quote tag for embedding `sql` as a literal: $mig$, else $mig1$,
 * $mig2$, ... Postgres ends the literal at the first occurrence of the tag, so
 * it must not appear in the text, nor straddle its end and the closing tag
 * (text ending in "$mig" followed by "$mig$").
 * @param {string} sql
 * @returns {string}
 */
export function dollarQuoteTag(sql) {
  for (let i = 0; ; i++) {
    const tag = `$mig${i || ""}$`;
    if ((sql + tag).indexOf(tag) === sql.length) return tag;
  }
}

/** A 'literal' with quotes doubled (standard_conforming_strings is on in Supabase, so backslashes are plain). */
function sqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * The schema_migrations row `supabase db push` would write. The file's text is
 * the one element of `statements`, dollar-quoted so nothing in it needs escaping.
 * @param {Migration} migration
 */
function recordSql({ version, name, sql }) {
  const tag = dollarQuoteTag(sql);
  return (
    "insert into supabase_migrations.schema_migrations (version, name, statements) " +
    `values (${sqlString(version)}, ${sqlString(name)}, array[${tag}${sql}${tag}]);`
  );
}

/**
 * One migration as one transaction: its SQL, then its history row. A failure
 * leaves neither behind, so a re-run starts again from that migration.
 * @param {Migration} migration
 * @returns {string}
 */
export function applySqlFor(migration) {
  // The lone ";" ends the file's last statement even if the file doesn't.
  return ["begin;", migration.sql, ";", recordSql(migration), "commit;"].join("\n");
}

/**
 * Every migration plus the history table as a single transaction, for pasting
 * into a brand-new project's SQL editor.
 * @param {Migration[]} all
 * @returns {string}
 */
export function freshSetupSql(all) {
  return [
    "-- Bookmark Graveyard: the complete database for a brand-new Supabase project",
    `-- (${plural(all.length, "migration")} from supabase/migrations, written by \`npm run setup\`).`,
    "-- Run it once in the SQL editor. It is one transaction: all of it applies, or none of it does.",
    "-- For a project that already has some of it, set SUPABASE_ACCESS_TOKEN and run `npm run setup` instead.",
    "begin;",
    TRACKING_TABLE_SQL,
    ...all.flatMap((m) => ["", `-- ${m.version}_${m.name}.sql`, m.sql, ";", recordSql(m)]),
    "",
    "commit;",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------- HTTP

/** The useful part of an error body: its message field if it's JSON, else the text, cut short. */
function errorDetail(body) {
  let detail = body;
  try {
    const json = JSON.parse(body);
    detail = json?.message ?? json?.error ?? json?.detail?.message ?? json?.msg ?? body;
  } catch {
    // Not JSON: the raw text is the message.
  }
  const text = typeof detail === "string" ? detail : JSON.stringify(detail);
  return text.trim().slice(0, 300) || "empty response";
}

/** A fetch failure in a few words: "timed out", or the error with its cause (ENOTFOUND, ...). */
function describeError(err) {
  if (err?.name === "TimeoutError") return "timed out";
  const cause = err?.cause?.code ?? err?.cause?.message;
  const message = err instanceof Error ? err.message : String(err);
  return cause ? `${message} (${cause})` : message;
}

/**
 * Runs SQL through the Management API's "Run a query" endpoint as the postgres
 * role, authorised by a personal access token. Resolves to the rows of the last
 * statement that returned any ([] for DDL).
 * https://supabase.com/docs/reference/api/v1-run-a-query
 * @param {string} ref
 * @param {string} token
 * @param {string} query
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function runSql(ref, token, query) {
  const res = await fetch(`${MANAGEMENT_API}/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await res.text();
  if (res.status === 401) {
    throw new Error(`SUPABASE_ACCESS_TOKEN was rejected (401: ${errorDetail(body)}); create a new one at ${TOKENS_PAGE}`);
  }
  if (res.status === 403 || res.status === 404) {
    throw new Error(`this token can't reach project ${ref} (${res.status}: ${errorDetail(body)})`);
  }
  if (!res.ok) throw new Error(`Management API ${res.status}: ${errorDetail(body)}`);
  try {
    return body ? JSON.parse(body) : [];
  } catch {
    throw new Error(`unexpected Management API response (${res.status}): ${errorDetail(body)}`);
  }
}

/**
 * Versions recorded in supabase_migrations.schema_migrations, or none when the
 * table doesn't exist yet. Only reads: nothing is written before the user says yes.
 * @param {string} ref
 * @param {string} token
 * @returns {Promise<string[]>}
 */
export async function appliedVersions(ref, token) {
  const [probe] = await runSql(
    ref,
    token,
    "select to_regclass('supabase_migrations.schema_migrations') is not null as tracked;"
  );
  if (!probe?.tracked) return [];
  const rows = await runSql(ref, token, "select version from supabase_migrations.schema_migrations order by version;");
  return rows.map((row) => String(row.version));
}

/**
 * The token path: read what's applied, ask, then apply each pending migration
 * as its own transaction, stopping at the first failure.
 * @param {{ ref: string, token: string, migrations: Migration[], confirm: (question: string) => Promise<boolean>, log?: (line: string) => void }} options
 * @returns {Promise<{ ok: boolean, applied: number }>}
 */
export async function migrateWithToken({ ref, token, migrations, confirm, log = say }) {
  const applied = await appliedVersions(ref, token);
  const local = new Set(migrations.map((m) => m.version));
  const unknown = applied.filter((version) => !local.has(version));
  if (unknown.length) {
    log(`  – the database also has ${plural(unknown.length, "version")} not in supabase/migrations (left alone): ${unknown.join(", ")}`);
  }

  const pending = pendingMigrations(migrations, applied);
  if (!pending.length) {
    log(`  ✓ database already up to date (${migrations.length}/${migrations.length})`);
    return { ok: true, applied: 0 };
  }
  if (!(await confirm(`Apply ${plural(pending.length, "pending migration")} to ${ref}? [y/N] `))) {
    log(`  ✗ not applied: ${plural(pending.length, "migration")} still pending`);
    return { ok: false, applied: 0 };
  }

  // Created only after the yes, so saying no leaves the database untouched.
  await runSql(ref, token, TRACKING_TABLE_SQL);
  for (const [done, migration] of pending.entries()) {
    try {
      await runSql(ref, token, applySqlFor(migration));
    } catch (err) {
      const reason = describeError(err);
      log(`  ✗ ${migration.version}_${migration.name}: ${reason}`);
      log("    It ran as one transaction, so none of it was applied. Fix it and re-run `npm run setup`.");
      if (/already exists/i.test(reason)) {
        log("    If this schema was created by hand, mark those versions as applied with");
        log("    `supabase migration repair --status applied <version>` and re-run.");
      }
      return { ok: false, applied: done };
    }
    log(`  ✓ ${migration.version}_${migration.name}`);
  }
  log(`  ✓ applied ${plural(pending.length, "migration")}`);
  return { ok: true, applied: pending.length };
}

/**
 * Supabase's gateway takes the key on `apikey`. A legacy JWT key goes on
 * Authorization too; the newer sb_secret_ keys must not, as they aren't JWTs
 * (https://supabase.com/docs/guides/api/api-keys).
 * @param {string} key
 * @returns {Record<string, string>}
 */
export function supabaseHeaders(key) {
  return key.startsWith("eyJ") ? { apikey: key, Authorization: `Bearer ${key}` } : { apikey: key };
}

/**
 * GET a Supabase REST or Storage URL with the service-role key.
 * @param {string} url
 * @param {string} key
 * @returns {Promise<{ status: number, body: string }>}
 */
export async function supabaseGet(url, key) {
  const res = await fetch(url, { headers: supabaseHeaders(key), signal: AbortSignal.timeout(20_000) });
  return { status: res.status, body: await res.text() };
}

/**
 * Like src/lib/voice/vendor.ts: 401/403, or a 400 that names the key (xAI's
 * answer to a bad key), mean the key is wrong; anything else proves nothing.
 * @param {number} status
 * @param {string} body
 * @returns {"ok" | "invalid" | "unknown"}
 */
export function keyVerdict(status, body) {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401 || status === 403 || (status === 400 && /api key/i.test(body))) return "invalid";
  return "unknown";
}

/** @returns {Promise<{ verdict: "ok" | "invalid" | "unknown", detail: string }>} */
async function checkKey(url, headers) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    const body = await res.text();
    return { verdict: keyVerdict(res.status, body), detail: `${res.status}: ${errorDetail(body)}` };
  } catch (err) {
    return { verdict: "unknown", detail: describeError(err) };
  }
}

/** xAI's model list: free, and needs a valid key. @param {string} key */
export function checkXaiKey(key) {
  return checkKey("https://api.x.ai/v1/models", { Authorization: `Bearer ${key}` });
}

/** ElevenLabs' voice list: free, and the call the app's Voices panel makes. @param {string} key */
export function checkElevenLabsKey(key) {
  return checkKey("https://api.elevenlabs.io/v1/voices", { "xi-api-key": key });
}

// ---------------------------------------------------------------- steps

/** The value if it's set and not the .env.example placeholder. */
function usable(env, placeholders, name) {
  const value = env[name];
  return value && value !== placeholders[name] ? value : undefined;
}

/** Steps 1 and 2: load .env.local, generate missing secrets, print the checklist. */
function stepEnvironment(checkOnly) {
  heading("Environment (.env.local)");
  const example = existsSync(EXAMPLE_FILE) ? readFileSync(EXAMPLE_FILE, "utf8") : "";
  let text = "";
  if (existsSync(ENV_FILE)) {
    text = readFileSync(ENV_FILE, "utf8");
  } else if (checkOnly) {
    say("  ✗ .env.local not found; run `npm run setup` without --check to create it from .env.example");
  } else if (example) {
    // 0600: the file is about to hold secrets. "wx" never overwrites one that appeared meanwhile.
    writeFileSync(ENV_FILE, example, { flag: "wx", mode: 0o600 });
    text = example;
    say("  ✓ created .env.local from .env.example; fill in the values marked ✗ (SETUP.md says where to get each)");
  } else {
    say("  ✗ neither .env.local nor .env.example exists");
  }

  // A real environment variable beats the file, as in Next.js; a blank one doesn't count.
  const fromShell = (name) => process.env[name] || undefined;
  /** @type {string[]} */
  let generated = [];
  if (!checkOnly && existsSync(ENV_FILE)) {
    const filled = fillMissingSecrets(text, GENERATED_SECRETS.filter((name) => !fromShell(name)));
    if (filled.generated.length) {
      writeFileSync(ENV_FILE, filled.text);
      ({ text, generated } = filled);
    }
  }

  /** @type {Record<string, string | undefined>} */
  const env = parseEnvFile(text);
  for (const name of [...REQUIRED, ...GENERATED_SECRETS, ...OPTIONAL, "SUPABASE_ACCESS_TOKEN"]) {
    env[name] = fromShell(name) ?? env[name];
  }
  for (const name of SECRET_NAMES) {
    if ((env[name]?.length ?? 0) >= 8) secrets.add(env[name]);
  }

  const placeholders = placeholderValues(example);
  let ok = true;
  for (const [name, problem] of checkRequired(env, placeholders)) {
    if (!problem) {
      say(row("✓", name, generated.includes(name) ? "generated and saved to .env.local" : ""));
      continue;
    }
    ok = false;
    const willGenerate = checkOnly && problem === "missing" && GENERATED_SECRETS.includes(name);
    say(row("✗", name, willGenerate ? "missing; `npm run setup` generates it" : problem));
  }
  say("  Optional:");
  for (const [marker, name, note] of optionalStatus(env, placeholders)) say(row(marker, name, note));
  return { env, placeholders, ok };
}

/** Step 3: apply pending migrations (token) or write the fresh-project SQL file (no token). */
async function stepDatabase(env, placeholders, { checkOnly, assumeYes }) {
  const url = usable(env, placeholders, "NEXT_PUBLIC_SUPABASE_URL");
  const ref = projectRefFromUrl(url);
  heading(ref ? `Database (Supabase project ${ref})` : "Database");
  if (!url) {
    say("  – skipped: NEXT_PUBLIC_SUPABASE_URL isn't filled in");
    return { ok: true, applied: 0 };
  }
  if (!ref) {
    say("  – can't tell the project ref from NEXT_PUBLIC_SUPABASE_URL (expected https://<ref>.supabase.co);");
    say("    apply supabase/migrations yourself, e.g. with `supabase db push`");
    return { ok: true, applied: 0 };
  }

  try {
    const migrations = readMigrations(MIGRATIONS_DIR);
    const token = env.SUPABASE_ACCESS_TOKEN;
    if (checkOnly) {
      say(`  – skipped: --check never touches the database (supabase/migrations has ${plural(migrations.length, "migration")})`);
      if (token) {
        say("    SUPABASE_ACCESS_TOKEN is set, so `npm run setup` will apply any pending ones.");
      } else {
        say(`    To apply pending ones, set SUPABASE_ACCESS_TOKEN (${TOKENS_PAGE})`);
        say("    and run `npm run setup`. Without a token it writes a SQL file for a brand-new project instead.");
      }
      return { ok: true, applied: 0 };
    }
    if (token) {
      const confirm = assumeYes ? async () => true : askYesNo;
      return await migrateWithToken({ ref, token, migrations, confirm });
    }

    // A private directory, not a fixed name in a shared /tmp that someone else could pre-create.
    const file = join(mkdtempSync(join(tmpdir(), "bookmark-graveyard-")), "setup.sql");
    writeFileSync(file, freshSetupSql(migrations));
    say("  – SUPABASE_ACCESS_TOKEN not set, so setup can't see which migrations this project already has.");
    say(`  ✓ wrote the whole schema (${plural(migrations.length, "migration")}, one transaction) to`);
    say(`      ${file}`);
    say(`    Paste it into the SQL editor and run it: https://supabase.com/dashboard/project/${ref}/sql/new`);
    say("    That file is for a brand-new project. For an existing one, set SUPABASE_ACCESS_TOKEN");
    say(`    (${TOKENS_PAGE}) and re-run \`npm run setup\`, or use \`supabase db push\`.`);
    return { ok: true, applied: 0 };
  } catch (err) {
    say(`  ✗ ${describeError(err)}`);
    return { ok: false, applied: 0 };
  }
}

/** Asks on the terminal; anything but y/yes is a no, and so is having no terminal. */
async function askYesNo(question) {
  if (!process.stdin.isTTY) {
    say(`  – can't ask "${question.trim()}" without a terminal; re-run with --yes to apply`);
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`  ${question}`)).trim());
  } finally {
    rl.close();
  }
}

/** supabaseGet, retrying a 404 (PostgREST's answer while its schema cache catches up) a few times. */
async function getRetrying404(url, key, attempts) {
  for (let attempt = 1; ; attempt++) {
    const res = await supabaseGet(url, key);
    if (res.status !== 404 || attempt >= attempts) return res;
    await new Promise((done) => setTimeout(done, 1500));
  }
}

/** Step 4: can the service-role key see the schema and the episodes bucket? */
async function stepVerify(env, placeholders, justApplied) {
  heading("Database check (service-role key)");
  const url = usable(env, placeholders, "NEXT_PUBLIC_SUPABASE_URL");
  const key = usable(env, placeholders, "SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    say("  – skipped: needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY filled in");
    return false;
  }
  const base = url.replace(/\/+$/, "");
  // PostgREST reloads its schema cache a moment after DDL, so fresh migrations get a few tries.
  const attempts = justApplied ? 5 : 1;
  let ok = true;
  try {
    const schema = await getRetrying404(`${base}/rest/v1/users?select=id&limit=0`, key, attempts);
    if (schema.status === 200) {
      say("  ✓ schema reachable (public.users)");
    } else {
      ok = false;
      const missing = schema.status === 404 || /PGRST205|42P01/.test(schema.body);
      say(missing
        ? "  ✗ table public.users not found: the schema isn't applied yet"
        : `  ✗ schema check failed (${schema.status}: ${errorDetail(schema.body)})`);
    }

    const bucket = await getRetrying404(`${base}/storage/v1/bucket/episodes`, key, attempts);
    if (bucket.status === 200) {
      const isPublic = /"public"\s*:\s*true/.test(bucket.body);
      say(`  ✓ storage bucket "episodes" exists${isPublic ? "" : " (private)"}`);
      if (isPublic) say('  ✗ bucket "episodes" is public, so anyone with a link can fetch episodes; make it private (warning)');
    } else {
      ok = false;
      say(/not.found/i.test(bucket.body) || bucket.status === 404
        ? '  ✗ storage bucket "episodes" not found: the schema isn\'t applied yet'
        : `  ✗ bucket check failed (${bucket.status}: ${errorDetail(bucket.body)})`);
    }
  } catch (err) {
    say(`  ✗ couldn't reach ${base}: ${describeError(err)}`);
    return false;
  }
  if (!ok) say("    Provision the database (see above), then check again: npm run setup -- --check");
  return ok;
}

/** Step 5: vendor keys, with free calls only. X can't be checked without signing in. */
async function stepKeys(env, placeholders) {
  heading("API keys");
  let ok = true;
  const xai = usable(env, placeholders, "XAI_API_KEY");
  if (!xai) {
    say("  – xAI: skipped (XAI_API_KEY isn't filled in)");
  } else {
    const { verdict, detail } = await checkXaiKey(xai);
    if (verdict === "ok") say("  ✓ xAI key works");
    else if (verdict === "unknown") say(`  – xAI key not verified (${detail}); try again later`);
    else {
      ok = false; // Every brief needs Grok, so a rejected key is as good as a missing one.
      say(`  ✗ xAI rejected XAI_API_KEY (${detail})`);
    }
  }

  const elevenLabs = usable(env, placeholders, "ELEVENLABS_API_KEY");
  if (elevenLabs) {
    const { verdict, detail } = await checkElevenLabsKey(elevenLabs);
    if (verdict === "ok") say("  ✓ ElevenLabs key works");
    else if (verdict === "unknown") say(`  – ElevenLabs key not verified (${detail})`);
    else say(`  ✗ ElevenLabs rejected ELEVENLABS_API_KEY (${detail}); ElevenLabs voices won't work (warning)`);
  }

  say("  – X_CLIENT_ID / X_CLIENT_SECRET can only be checked by signing in. Register this callback URL:");
  say(`      ${env.APP_URL || DEFAULT_APP_URL}/api/auth/callback/x`);
  return ok;
}

function stepNext(env, ok) {
  heading("Next steps");
  const steps = [
    ...(ok ? [] : ["Fix the ✗ items above, then run `npm run setup` again."]),
    "Add the callback URL above to your X app\n     (console.x.com > Apps > your app > Settings > Callback URI / Redirect URL).",
    "npm run dev",
    `Open ${env.APP_URL || DEFAULT_APP_URL} and click "Sign in with X".`,
    "Choose the podcast voices in the app (Voices panel). VOICE_PROVIDER, GROK_VOICE_HOST_*\n     and ELEVENLABS_* in .env.local are optional server defaults.",
  ];
  steps.forEach((step, i) => say(`  ${i + 1}. ${step}`));
}

const USAGE = `Usage: npm run setup -- [--check | --yes]
  --check  only check: writes no files and never touches the database
  --yes    apply pending migrations without asking`;

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => !["--check", "--yes", "--help", "-h"].includes(arg));
  if (unknown.length || args.includes("--help") || args.includes("-h")) {
    if (unknown.length) say(`Unknown option: ${unknown.join(" ")}`);
    say(USAGE);
    process.exitCode = unknown.length ? 1 : 0;
    return;
  }
  const checkOnly = args.includes("--check");
  const assumeYes = args.includes("--yes");

  say(checkOnly ? "Bookmark Graveyard setup: check only (writes nothing, leaves the database alone)" : "Bookmark Graveyard setup");
  const { env, placeholders, ok: envOk } = stepEnvironment(checkOnly);
  const db = await stepDatabase(env, placeholders, { checkOnly, assumeYes });
  const verified = await stepVerify(env, placeholders, db.applied > 0);
  const keysOk = await stepKeys(env, placeholders);
  const ok = envOk && db.ok && verified && keysOk;
  stepNext(env, ok);
  process.exitCode = ok ? 0 : 1;
}

/** True when run as `node scripts/setup.mjs`, false when the tests import it. */
function isEntryPoint() {
  try {
    // realpath, so a symlinked checkout still matches import.meta.url.
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (process.argv[1] && isEntryPoint()) {
  main().catch((err) => {
    say(`✗ ${describeError(err)}`);
    process.exitCode = 1;
  });
}
