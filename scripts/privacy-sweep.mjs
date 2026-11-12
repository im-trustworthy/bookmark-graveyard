#!/usr/bin/env node
/**
 * Privacy sweep: blocks a push or a CI run that would publish personal data or
 * credentials. `npm run sweep`, the CI "check" job and the pre-push hook in
 * .githooks/ all run it.
 *
 *   1. Every file in a commit's tree: key-shaped strings, private keys, personal
 *      email addresses, Supabase project ids, phone numbers, paths on someone's
 *      computer, committed .env files and to-do markers.
 *   2. Every line added by the commits being checked (all of history on main,
 *      a pull request's own commits, the new commits before a push): the same
 *      rules except to-do markers, because a line that a later commit deleted
 *      is still public.
 *   3. Commit messages, and author and committer names and emails, against the
 *      private patterns.
 *
 * Private patterns are strings that must never be published but can't be
 * listed in a public repo either (a real name, a domain, a project id). One per
 * line, matched case-insensitively, `#` starts a comment. They come from the
 * PRIVACY_SWEEP_PATTERNS environment variable (a repository secret in CI) and
 * from .git/info/privacy-patterns, which git never commits.
 *
 * Usage: node scripts/privacy-sweep.mjs [rev]   checks rev (default HEAD) and its history
 *        node scripts/privacy-sweep.mjs [rev] --since <base>   only the commits base lacks
 *        node scripts/privacy-sweep.mjs --pre-push <remote>   reads git's pre-push input
 *
 * Exits 1 when anything is found, 2 when git fails. With CI set it reports
 * where a problem is but never what it is, since public CI logs are public.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ZERO_SHA = /^0+$/;
const MAX_FILE_BYTES = 1024 * 1024;
const BINARY_EXTENSIONS = /\.(?:ttf|otf|woff2?|eot|png|jpe?g|gif|webp|ico|bmp|mp3|mp4|m4a|wav|ogg|webm|mov|pdf|zip|gz|tgz)$/i;

// ---------------------------------------------------------------- rules

/** Addresses that are fine to publish: reserved example domains and no-reply senders. */
const ALLOWED_EMAIL = [
  /@(?:[a-z0-9-]+\.)*example\.(?:com|org|net)$/i,
  /@(?:[a-z0-9-]+\.)*[a-z0-9-]+\.(?:example|test|invalid|localhost)$/i,
  /@users\.noreply\.github\.com$/i,
  /^noreply@(?:github\.com|anthropic\.com)$/i,
  /^git@github\.com$/i,
  // Not an address at all: a file name such as logo@2x.png.
  /\.(?:png|jpe?g|gif|svg|webp|js|mjs|cjs|ts|tsx|json|css|md)$/i,
];

/** The placeholder ref setup.mjs and its tests use. */
const PLACEHOLDER_SUPABASE_REF = "abcdefghijklmnopqrst";

/**
 * Each rule finds one kind of problem. `scope` says where it applies: "content"
 * means files in the tree and lines added in history, "tree" means files in the
 * tree only. `allow` exempts a match, `skipPath` exempts a whole file.
 * @type {{ id: string, scope: "content" | "tree", pattern: RegExp, allow?: (match: string) => boolean, skipPath?: (path: string) => boolean }[]}
 */
export const RULES = [
  {
    id: "private-key",
    scope: "content",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    id: "api-key",
    scope: "content",
    pattern: new RegExp(
      [
        String.raw`eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`, // JWT, e.g. a Supabase service-role key
        String.raw`\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{20,}`, // Supabase API keys
        String.raw`\bxai-[A-Za-z0-9]{32,}`, // xAI
        String.raw`\bsk[-_][A-Za-z0-9_-]{32,}`, // ElevenLabs, OpenAI, Stripe
        String.raw`\bgh[pousr]_[A-Za-z0-9]{36,}`, // GitHub tokens
        String.raw`\bgithub_pat_[A-Za-z0-9_]{60,}`,
        String.raw`\bAKIA[0-9A-Z]{16}\b`, // AWS access key id
        String.raw`\bbgr?_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])`, // this app's own access and refresh tokens
      ].join("|"),
      "g",
    ),
  },
  {
    id: "email",
    scope: "content",
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
    allow: (match) => ALLOWED_EMAIL.some((re) => re.test(match)),
    // Third-party font licences name their authors.
    skipPath: (path) => path.startsWith("fonts/"),
  },
  {
    id: "supabase-project",
    scope: "content",
    pattern: /\b[a-z0-9]{20}\.supabase\.(?:co|in)\b|supabase\.com\/dashboard\/project\/[a-z0-9]{20}\b/g,
    allow: (match) => match.includes(PLACEHOLDER_SUPABASE_REF),
  },
  {
    id: "local-path",
    scope: "content",
    pattern: /\/Users\/[^/\s"'`]+\/|\/home\/[a-z_][^/\s"'`]*\/|\b[A-Za-z]:\\Users\\[^\\\s"'`]+\\|\/private\/(?:tmp|var)\/|\/var\/folders\//g,
  },
  {
    id: "phone",
    scope: "content",
    pattern: /(?<![\d.])(?:\+1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?![\d.])|(?<![\w.])\+\d{1,3}(?:[ .-]\d{2,4}){2,4}(?![\d.])/g,
  },
  {
    id: "todo-marker",
    scope: "tree",
    // The bracketed letters keep this line from matching itself.
    pattern: /\b(?:T[O]DO|F[I]XME|X[X]X|H[A]CK)\b/g,
  },
];

/** A tracked .env file other than the template. */
export function isEnvFile(path) {
  const name = path.split("/").pop() ?? "";
  return /^\.env(?:\..+)?$/.test(name) && name !== ".env.example";
}

/** True for files the sweep can't read as text. */
export function isBinaryPath(path) {
  return BINARY_EXTENSIONS.test(path);
}

/**
 * Turns the private-pattern text into lowercase strings. Lines shorter than
 * four characters are dropped, since they would match almost everything.
 * @param {string} text
 * @returns {string[]}
 */
export function parsePatterns(text) {
  const out = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length >= 4 && !line.startsWith("#")) out.add(line.toLowerCase());
  }
  return [...out];
}

/**
 * @typedef {{ rule: string, where: string, path?: string, line?: number, match: string }} Finding
 */

/**
 * Checks one line. `scope` is "tree" for a file as it is now and "history"
 * for a line some commit added; tree-only rules skip history.
 * @param {string} text
 * @param {{ path: string, line: number, where: string, scope: "tree" | "history", patterns: string[] }} at
 * @returns {Finding[]}
 */
export function scanLine(text, { path, line, where, scope, patterns }) {
  /** @type {Finding[]} */
  const found = [];
  for (const rule of RULES) {
    if (rule.scope === "tree" && scope !== "tree") continue;
    if (rule.skipPath?.(path)) continue;
    for (const m of text.matchAll(rule.pattern)) {
      if (!rule.allow?.(m[0])) found.push({ rule: rule.id, where, path, line, match: m[0] });
    }
  }
  const lower = text.toLowerCase();
  for (const p of patterns) {
    if (lower.includes(p)) found.push({ rule: "private-pattern", where, path, line, match: p });
  }
  return found;
}

/**
 * Checks a whole file's text line by line, plus its path.
 * @param {string} path
 * @param {string} text
 * @param {{ where: string, scope: "tree" | "history", patterns: string[] }} opts
 * @returns {Finding[]}
 */
export function scanFile(path, text, { where, scope, patterns }) {
  const found = scanPath(path, { where, patterns });
  text.split("\n").forEach((content, i) => {
    found.push(...scanLine(content, { path, line: i + 1, where, scope, patterns }));
  });
  return found;
}

/**
 * A path can leak too: a committed .env file, or a private name in a file name.
 * @returns {Finding[]}
 */
export function scanPath(path, { where, patterns }) {
  /** @type {Finding[]} */
  const found = [];
  if (isEnvFile(path)) found.push({ rule: "env-file", where, path, match: path });
  const lower = path.toLowerCase();
  for (const p of patterns) {
    if (lower.includes(p)) found.push({ rule: "private-pattern", where, path, match: p });
  }
  return found;
}

// ---------------------------------------------------------------- history

const COMMIT_START = "\x1e";
const FIELD = "\x1f";
const MESSAGE_END = "\x1d";
export const LOG_FORMAT = `--format=${COMMIT_START}%H${FIELD}%an${FIELD}%ae${FIELD}%cn${FIELD}%ce${FIELD}%B${MESSAGE_END}`;

/**
 * Splits `git log -p -U0` output (in LOG_FORMAT) into commits, each with its
 * metadata and the lines it added.
 * @param {string} log
 * @returns {{ sha: string, author: string, authorEmail: string, committer: string, committerEmail: string, message: string, paths: string[], added: { path: string, line: number, text: string }[] }[]}
 */
export function parseLog(log) {
  const commits = [];
  for (const chunk of log.split(COMMIT_START)) {
    const end = chunk.indexOf(MESSAGE_END);
    if (end === -1) continue;
    const [sha, author, authorEmail, committer, committerEmail, ...rest] = chunk.slice(0, end).split(FIELD);
    const commit = { sha, author, authorEmail, committer, committerEmail, message: rest.join(FIELD), paths: [], added: [] };
    let path = "";
    let line = 0;
    for (const text of chunk.slice(end + 1).split("\n")) {
      if (text.startsWith("+++ ")) {
        const target = text.slice(4).replace(/^"|"$/g, "");
        path = target === "/dev/null" ? "" : target.replace(/^b\//, "");
        if (path) commit.paths.push(path);
      } else if (text.startsWith("@@")) {
        line = Number(/\+(\d+)/.exec(text)?.[1] ?? 0);
      } else if (text.startsWith("+") && path) {
        commit.added.push({ path, line: line++, text: text.slice(1) });
      }
    }
    commits.push(commit);
  }
  return commits;
}

/**
 * Checks commits: their metadata against the private patterns, their messages
 * against the content rules (not the email rule: co-author lines are normal),
 * and every line they added.
 * @param {ReturnType<typeof parseLog>} commits
 * @param {string[]} patterns
 * @returns {Finding[]}
 */
export function scanCommits(commits, patterns) {
  /** @type {Finding[]} */
  const found = [];
  for (const c of commits) {
    const where = `commit ${c.sha.slice(0, 7)}`;
    const people = [c.author, c.authorEmail, c.committer, c.committerEmail].join(" ").toLowerCase();
    for (const p of patterns) {
      if (people.includes(p)) found.push({ rule: "private-pattern", where: `${where} author/committer`, match: p });
    }
    c.message.split("\n").forEach((text) => {
      for (const f of scanLine(text, { path: "", line: 0, where: `${where} message`, scope: "history", patterns })) {
        if (f.rule !== "email") found.push({ rule: f.rule, where: f.where, match: f.match });
      }
    });
    for (const path of c.paths) found.push(...scanPath(path, { where, patterns }));
    for (const a of c.added) {
      found.push(...scanLine(a.text, { path: a.path, line: a.line, where, scope: "history", patterns }));
    }
  }
  return found;
}

// ---------------------------------------------------------------- pre-push

/**
 * Parses the lines git feeds a pre-push hook: `<local ref> <local sha> <remote
 * ref> <remote sha>`. Deletions (an all-zero local sha) are dropped.
 * @param {string} input
 */
export function parsePrePush(input) {
  return input
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((parts) => parts.length === 4 && !ZERO_SHA.test(parts[1]))
    .map(([localRef, localSha, remoteRef, remoteSha]) => ({ localRef, localSha, remoteRef, remoteSha }));
}

// ---------------------------------------------------------------- git

function git(args, { input, encoding = "utf8" } = {}) {
  const res = spawnSync("git", ["-c", "core.quotePath=false", ...args], {
    input,
    encoding: encoding === "buffer" ? undefined : encoding,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (res.status !== 0) {
    const err = String(res.stderr ?? "").trim();
    throw new Error(`git ${args[0]} failed${err ? `: ${err}` : ""}`);
  }
  return res.stdout;
}

/** Reads every text file in a commit's tree and checks it. */
function scanTree(rev, patterns) {
  /** @type {{ sha: string, path: string }[]} */
  const blobs = [];
  /** @type {Finding[]} */
  const found = [];
  for (const entry of git(["ls-tree", "-r", "-l", "-z", "--full-tree", rev]).split("\0")) {
    const m = /^\d+ blob ([0-9a-f]+)\s+(\d+)\t(.+)$/.exec(entry);
    if (!m) continue;
    const [, sha, size, path] = m;
    found.push(...scanPath(path, { where: "tree", patterns }));
    if (!isBinaryPath(path) && Number(size) <= MAX_FILE_BYTES) blobs.push({ sha, path });
  }
  if (blobs.length === 0) return { files: 0, found };

  const out = git(["cat-file", "--batch"], { input: blobs.map((b) => b.sha).join("\n") + "\n", encoding: "buffer" });
  let offset = 0;
  for (const blob of blobs) {
    const headerEnd = out.indexOf(0x0a, offset);
    const size = Number(out.subarray(offset, headerEnd).toString().split(" ")[2]);
    const body = out.subarray(headerEnd + 1, headerEnd + 1 + size);
    offset = headerEnd + 1 + size + 1;
    if (body.includes(0)) continue; // binary after all
    found.push(...scanFile(blob.path, body.toString("utf8"), { where: "tree", scope: "tree", patterns }));
  }
  return { files: blobs.length, found };
}

function scanHistory(revArgs, patterns) {
  const log = git(["log", "-p", "-U0", "--no-color", "--no-ext-diff", "--no-renames", LOG_FORMAT, ...revArgs, "--"]);
  const commits = parseLog(log);
  return { commits: commits.length, found: scanCommits(commits, patterns) };
}

function loadPatterns() {
  let text = process.env.PRIVACY_SWEEP_PATTERNS ?? "";
  const file = join(resolve(git(["rev-parse", "--git-common-dir"]).trim()), "info", "privacy-patterns");
  if (existsSync(file)) text += `\n${readFileSync(file, "utf8")}`;
  return parsePatterns(text);
}

// ---------------------------------------------------------------- main

/**
 * Folds author/committer findings into one line per pattern, so an address on
 * every commit doesn't bury the findings in files.
 * @param {Finding[]} found
 * @returns {Finding[]}
 */
export function groupPeople(found) {
  const people = new Map();
  const rest = [];
  for (const f of found) {
    if (!f.where.endsWith("author/committer")) rest.push(f);
    else people.set(f.match, [...(people.get(f.match) ?? []), f.where.split(" ")[1]]);
  }
  for (const [match, shas] of people) {
    const list = shas.length > 3 ? `${shas.slice(0, 3).join(", ")}, …` : shas.join(", ");
    rest.push({ rule: "private-pattern", where: `author/committer of ${shas.length} commit${shas.length === 1 ? "" : "s"} (${list})`, match });
  }
  return rest;
}

/** One line per finding. In CI the matched text is left out. */
export function formatFinding(f, { reveal }) {
  const at = f.path ? `${f.path}${f.line ? `:${f.line}` : ""} (${f.where})` : f.where;
  return `  ✗ ${f.rule.padEnd(16)} ${at}${reveal ? `  ${JSON.stringify(f.match)}` : ""}`;
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main() {
  const args = process.argv.slice(2);
  const patterns = loadPatterns();
  /** @type {{ tip: string, history: string[] }[]} */
  const targets = [];

  if (args[0] === "--pre-push") {
    const remote = args[1] ?? "origin";
    for (const u of parsePrePush(readStdin())) {
      const history = [u.localSha];
      if (!ZERO_SHA.test(u.remoteSha) && spawnSync("git", ["cat-file", "-e", u.remoteSha]).status === 0) {
        history.push(`^${u.remoteSha}`);
      }
      targets.push({ tip: u.localSha, history: [...history, "--not", `--remotes=${remote}`] });
    }
    if (targets.length === 0) return 0;
  } else {
    const sinceAt = args.indexOf("--since");
    const since = sinceAt === -1 ? undefined : args[sinceAt + 1];
    if (sinceAt !== -1 && !since) throw new Error("--since needs a revision");
    const rev = args.find((a, i) => !a.startsWith("--") && (sinceAt === -1 || i !== sinceAt + 1)) ?? "HEAD";
    targets.push({ tip: rev, history: since ? [rev, `^${since}`] : [rev] });
  }

  /** @type {Finding[]} */
  const found = [];
  let files = 0;
  let commits = 0;
  for (const t of targets) {
    const tree = scanTree(t.tip, patterns);
    const history = scanHistory(t.history, patterns);
    files += tree.files;
    commits += history.commits;
    found.push(...tree.found, ...history.found);
  }

  const unique = groupPeople([...new Map(found.map((f) => [`${f.rule}|${f.where}|${f.path}|${f.line}|${f.match}`, f])).values()]);
  const summary = `Privacy sweep: ${files} files, ${commits} commits, ${patterns.length} private patterns`;
  if (unique.length === 0) {
    console.log(`${summary}. Nothing found.`);
    return 0;
  }
  const reveal = !process.env.CI;
  console.log(`${summary}. Found ${unique.length}:`);
  for (const f of unique.slice(0, 100)) console.log(formatFinding(f, { reveal }));
  if (unique.length > 100) console.log(`  … and ${unique.length - 100} more`);
  console.log(
    "\nRemove these before publishing. A line that is already in a pushed commit needs a history rewrite, not just a new commit.",
  );
  return 1;
}

/** True when run as `node scripts/privacy-sweep.mjs`, false when the tests import it. */
function isEntryPoint() {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (process.argv[1] && isEntryPoint()) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(`Privacy sweep could not run: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 2;
  }
}
