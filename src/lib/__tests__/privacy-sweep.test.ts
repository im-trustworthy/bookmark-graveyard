import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatFinding,
  groupPeople,
  isBinaryPath,
  isEnvFile,
  parseLog,
  parsePatterns,
  parsePrePush,
  scanCommits,
  scanFile,
  scanLine,
} from "../../../scripts/privacy-sweep.mjs";

// Fake leaks are assembled at runtime, so this file never trips the sweep it tests.
const join_ = (...parts: string[]) => parts.join("");
const GMAIL = join_("someone", "@", "gmail.com");
const XAI_KEY = join_("xai-", "A1b2".repeat(12));
const JWT = join_("eyJ", "hbGciOiJIUzI1NiJ9", ".", "eyJ", "yb2xlIjoic2VydmljZSJ9", ".", "c2lnbmF0dXJlLXZhbHVl");
const PHONE = ["555", "867", "5309"].join("-");
const MAC_PATH = join_("/Us", "ers/jane/projects/app");
const SUPABASE_URL = join_("https://", "qwertyuiopasdfghjklz", ".supabase.co");
const MARKER = join_("TO", "DO");

const SCRIPT = fileURLToPath(new URL("../../../scripts/privacy-sweep.mjs", import.meta.url));

function rulesFor(text: string, scope: "tree" | "history" = "tree", patterns: string[] = []) {
  return scanLine(text, { path: "src/x.ts", line: 1, where: "tree", scope, patterns }).map((f) => f.rule);
}

describe("scanLine", () => {
  it("flags key-shaped strings", () => {
    expect(rulesFor(`XAI_API_KEY=${XAI_KEY}`)).toEqual(["api-key"]);
    expect(rulesFor(`key: "${JWT}"`)).toEqual(["api-key"]);
    expect(rulesFor(join_("-----BEGIN ", "RSA PRIVATE KEY-----"))).toEqual(["private-key"]);
  });

  it("leaves the test suite's placeholder keys alone", () => {
    expect(rulesFor("SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0=.c2ln==")).toEqual([]);
    expect(rulesFor('{ key: "xai-leak-me-SECRET1" }')).toEqual([]);
    expect(rulesFor('token: "bg_not-a-real-token"')).toEqual([]);
  });

  it("flags personal email addresses but not example or no-reply ones", () => {
    expect(rulesFor(`Contact ${GMAIL}`)).toEqual(["email"]);
    for (const ok of [
      "pw@client.example.com",
      "pass@a.example",
      "Co-Authored-By: Claude <noreply@anthropic.com>",
      "123+someone@users.noreply.github.com",
      "git@github.com:owner/repo.git",
      "logo@2x.png",
    ]) {
      expect(rulesFor(ok)).toEqual([]);
    }
  });

  it("skips the email rule in third-party font licences", () => {
    const found = scanLine(`Copyright (c) by ${GMAIL}`, { path: "fonts/Some/OFL.txt", line: 1, where: "tree", scope: "tree", patterns: [] });
    expect(found).toEqual([]);
  });

  it("flags a real Supabase project id but not the placeholder", () => {
    expect(rulesFor(`SUPABASE_URL=${SUPABASE_URL}`)).toEqual(["supabase-project"]);
    expect(rulesFor("https://abcdefghijklmnopqrst.supabase.co")).toEqual([]);
    expect(rulesFor("https://your-project-ref.supabase.co")).toEqual([]);
  });

  it("flags paths on someone's computer", () => {
    expect(rulesFor(`"cwd": "${MAC_PATH}"`)).toEqual(["local-path"]);
    expect(rulesFor(join_("/priv", "ate/tmp/scratch/file"))).toEqual(["local-path"]);
    expect(rulesFor(join_("C:", "\\Users\\jane\\app"))).toEqual(["local-path"]);
    expect(rulesFor("node_modules/next/dist/docs/")).toEqual([]);
  });

  it("flags phone numbers but not dates, sizes or versions", () => {
    expect(rulesFor(`Call ${PHONE}`)).toEqual(["phone"]);
    expect(rulesFor(join_("+44 ", "20 7946 ", "0958"))).toEqual(["phone"]);
    for (const ok of ["2026-10-30", "1073741824 bytes", "next@16.4.3", "10.0.0.1", "0:00 / 13:45"]) {
      expect(rulesFor(ok)).toEqual([]);
    }
  });

  it("flags to-do markers in the tree only", () => {
    expect(rulesFor(`// ${MARKER}: tidy`)).toEqual(["todo-marker"]);
    expect(rulesFor(`// ${MARKER}: tidy`, "history")).toEqual([]);
    expect(rulesFor("a todo list app")).toEqual([]);
  });

  it("matches private patterns case-insensitively", () => {
    expect(rulesFor("Hosted at Bookmarks.Jane-Doe.dev", "history", ["jane-doe.dev"])).toEqual(["private-pattern"]);
  });
});

describe("files and paths", () => {
  it("flags committed .env files except the template", () => {
    expect(isEnvFile(".env")).toBe(true);
    expect(isEnvFile(".env.local")).toBe(true);
    expect(isEnvFile("apps/web/.env.production")).toBe(true);
    expect(isEnvFile(".env.example")).toBe(false);
    expect(isEnvFile("src/lib/env.ts")).toBe(false);
  });

  it("skips binary files by extension", () => {
    expect(isBinaryPath("fonts/Inter/Inter.ttf")).toBe(true);
    expect(isBinaryPath("docs/screenshots/app.JPG")).toBe(true);
    expect(isBinaryPath("docs/MCP.md")).toBe(false);
  });

  it("reports the line number and checks the path", () => {
    const found = scanFile("notes/jane-doe.md", `line one\nmail ${GMAIL}\n`, { where: "tree", scope: "tree", patterns: ["jane-doe"] });
    expect(found.map((f) => [f.rule, f.line])).toEqual([
      ["private-pattern", undefined],
      ["email", 2],
    ]);
  });

  it("never flags its own source or this test", () => {
    for (const file of [SCRIPT, fileURLToPath(import.meta.url)]) {
      expect(scanFile(file, readFileSync(file, "utf8"), { where: "tree", scope: "tree", patterns: [] })).toEqual([]);
    }
  });
});

describe("parsePatterns", () => {
  it("drops comments, blanks, duplicates and patterns too short to be safe", () => {
    expect(parsePatterns("# names\nJane-Doe\n\n  jane-doe  \nabc\nproj1234\r\n")).toEqual(["jane-doe", "proj1234"]);
  });
});

describe("history", () => {
  const RS = "\x1e";
  const US = "\x1f";
  const GS = "\x1d";
  const log = [
    `${RS}aaaaaaa1${US}Jane${US}${GMAIL}${US}GitHub${US}noreply@github.com${US}Add setup\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n${GS}`,
    "",
    "diff --git a/SETUP.md b/SETUP.md",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/SETUP.md",
    "@@ -0,0 +1,2 @@",
    "+# Setup",
    `+Open ${SUPABASE_URL}`,
    "diff --git a/old.txt b/old.txt",
    "deleted file mode 100644",
    "--- a/old.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-gone",
    `${RS}bbbbbbb2${US}Jane${US}jane@example.com${US}Jane${US}jane@example.com${US}Tidy up ${MAC_PATH}\n${GS}`,
    "",
    "diff --git a/SETUP.md b/SETUP.md",
    "--- a/SETUP.md",
    "+++ b/SETUP.md",
    "@@ -2 +2 @@",
    `-Open ${SUPABASE_URL}`,
    "+Open your project",
  ].join("\n");

  it("parses commits, their metadata and the lines they added", () => {
    const commits = parseLog(log);
    expect(commits.map((c) => c.sha)).toEqual(["aaaaaaa1", "bbbbbbb2"]);
    expect(commits[0].authorEmail).toBe(GMAIL);
    expect(commits[0].message).toContain("Co-Authored-By");
    expect(commits[0].paths).toEqual(["SETUP.md"]);
    expect(commits[0].added).toEqual([
      { path: "SETUP.md", line: 1, text: "# Setup" },
      { path: "SETUP.md", line: 2, text: `Open ${SUPABASE_URL}` },
    ]);
    expect(commits[1].added).toEqual([{ path: "SETUP.md", line: 2, text: "Open your project" }]);
  });

  it("flags a line a later commit removed, private authors and leaky messages", () => {
    const found = scanCommits(parseLog(log), [GMAIL]);
    expect(found.map((f) => `${f.rule} ${f.where} ${f.path ?? ""}:${f.line ?? ""}`)).toEqual([
      "private-pattern commit aaaaaaa author/committer :",
      "supabase-project commit aaaaaaa SETUP.md:2",
      "local-path commit bbbbbbb message :",
    ]);
  });

  it("does not apply the email rule to messages", () => {
    const signed = `${RS}ccccccc3${US}A${US}a@example.com${US}A${US}a@example.com${US}Fix\n\nSigned-off-by: A <${GMAIL}>\n${GS}`;
    expect(scanCommits(parseLog(signed), [])).toEqual([]);
  });

  it("folds author findings into one line per pattern", () => {
    const grouped = groupPeople([
      { rule: "private-pattern", where: "commit aaaaaaa author/committer", match: "x" },
      { rule: "private-pattern", where: "commit bbbbbbb author/committer", match: "x" },
      { rule: "email", where: "tree", path: "a.md", line: 3, match: GMAIL },
    ]);
    expect(grouped.map((f) => f.where)).toEqual(["tree", "author/committer of 2 commits (aaaaaaa, bbbbbbb)"]);
  });
});

describe("parsePrePush", () => {
  it("reads git's ref lines and drops deletions", () => {
    const zero = "0".repeat(40);
    const sha = "1".repeat(40);
    const input = `refs/heads/feat ${sha} refs/heads/feat ${zero}\n(delete) ${zero} refs/heads/old ${sha}\n`;
    expect(parsePrePush(input)).toEqual([{ localRef: "refs/heads/feat", localSha: sha, remoteRef: "refs/heads/feat", remoteSha: zero }]);
  });
});

describe("formatFinding", () => {
  it("leaves the matched text out in CI", () => {
    const f = { rule: "email", where: "tree", path: "README.md", line: 4, match: GMAIL };
    expect(formatFinding(f, { reveal: false })).not.toContain(GMAIL);
    expect(formatFinding(f, { reveal: true })).toContain(GMAIL);
  });
});

describe("the command", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  function run(cwd: string, args: string[], env: Record<string, string> = {}, input = "") {
    const res = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd,
      input,
      encoding: "utf8",
      env: { ...process.env, PRIVACY_SWEEP_PATTERNS: "", CI: "", ...env },
    });
    return { code: res.status, out: res.stdout + res.stderr };
  }

  function commit(cwd: string, file: string, text: string) {
    writeFileSync(join(cwd, file), text);
    const env = { ...process.env, GIT_AUTHOR_NAME: "Jane", GIT_AUTHOR_EMAIL: "jane@example.com", GIT_COMMITTER_NAME: "Jane", GIT_COMMITTER_EMAIL: "jane@example.com" };
    spawnSync("git", ["add", "-A"], { cwd, env });
    spawnSync("git", ["commit", "-q", "-m", `edit ${file}`], { cwd, env });
    return spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).stdout.trim();
  }

  it("passes a clean repo and fails one whose history leaked, without printing the leak in CI", () => {
    dir = mkdtempSync(join(tmpdir(), "sweep-"));
    spawnSync("git", ["init", "-q"], { cwd: dir });
    commit(dir, "README.md", "# Demo\n");
    expect(run(dir, []).code).toBe(0);

    commit(dir, "notes.md", `cwd: ${MAC_PATH}\n`);
    const clean = commit(dir, "notes.md", "nothing here\n");
    const local = run(dir, []);
    expect(local.code).toBe(1);
    expect(local.out).toContain("local-path       notes.md:1");
    const leaked = join_("/Us", "ers/jane/");
    expect(local.out).toContain(leaked);

    const ci = run(dir, [], { CI: "true" });
    expect(ci.code).toBe(1);
    expect(ci.out).toContain("notes.md:1");
    expect(ci.out).not.toContain(leaked);

    // A pull request is judged on its own commits: none since `clean` here.
    expect(run(dir, ["HEAD", "--since", clean]).code).toBe(0);
    expect(run(dir, ["--since", `${clean}~2`]).code).toBe(1);

    // Before a push, only the commits the remote lacks are read: none here.
    const zero = "0".repeat(40);
    expect(run(dir, ["--pre-push", "origin"], {}, `refs/heads/main ${clean} refs/heads/main ${clean}\n`).code).toBe(0);
    expect(run(dir, ["--pre-push", "origin"], {}, `refs/heads/main ${clean} refs/heads/main ${zero}\n`).code).toBe(1);
  });

  it("reads private patterns from the environment", () => {
    dir = mkdtempSync(join(tmpdir(), "sweep-"));
    spawnSync("git", ["init", "-q"], { cwd: dir });
    commit(dir, "about.md", "Built by Jane Doe\n");
    expect(run(dir, []).code).toBe(0);
    expect(run(dir, [], { PRIVACY_SWEEP_PATTERNS: "# names\njane doe\n" }).code).toBe(1);
  });
});
