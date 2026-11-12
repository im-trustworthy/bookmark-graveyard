import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BRIEF_JOB_STAGES, BRIEF_JOB_STATES } from "../state/brief-job";
import { EPISODE_STATUSES } from "../state/episode";

// A lifecycle held in a text column has two definitions: the TypeScript array and the CHECK constraint.
// This reads the constraint out of the migration files and proves the two list the same values.
const MIGRATIONS_DIR = fileURLToPath(new URL("../../../supabase/migrations", import.meta.url));

type Migration = { file: string; sql: string };

function readMigrationFiles(dir: string): Migration[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => ({ file, sql: readFileSync(join(dir, file), "utf8") }));
}

/**
 * The allowed values of `table.column` from the last migration (in version order) that defines a
 * `check (column in (...))` for it, or null when no migration does. A later migration that replaces
 * the constraint wins. The table comes from the `create table` or `alter table` the check sits in.
 */
function constraintValues(migrations: readonly Migration[], table: string, column: string): string[] | null {
  let found: string[] | null = null;
  const checkPattern = /check\s*\(\s*"?(\w+)"?\s+in\s*\(([^)]*)\)\s*\)/gi;
  for (const { sql } of [...migrations].sort((a, b) => a.file.localeCompare(b.file))) {
    const statements = sql.replace(/--[^\n]*/g, "").split(";");
    for (const statement of statements) {
      const target = /^\s*(?:create\s+table(?:\s+if\s+not\s+exists)?|alter\s+table(?:\s+if\s+exists)?(?:\s+only)?)\s+(?:public\.)?"?(\w+)"?/i.exec(statement);
      if (!target || target[1].toLowerCase() !== table) continue;
      for (const match of statement.matchAll(checkPattern)) {
        if (match[1].toLowerCase() !== column) continue;
        found = [...match[2].matchAll(/'([^']*)'/g)].map((value) => value[1]);
      }
    }
  }
  return found;
}

/** Null when the constraint allows exactly `expected`; otherwise a message naming the column and the differences. */
function describeMismatch(
  column: string,
  allowed: readonly string[] | null,
  expected: readonly string[],
): string | null {
  if (allowed === null) return `${column}: no CHECK constraint found in the migrations`;
  const allowedSet = new Set(allowed);
  const expectedSet = new Set(expected);
  const missing = [...expectedSet].filter((value) => !allowedSet.has(value));
  const extra = [...allowedSet].filter((value) => !expectedSet.has(value));
  if (missing.length === 0 && extra.length === 0) return null;
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`in the code but not the constraint: ${missing.join(", ")}`);
  if (extra.length > 0) parts.push(`in the constraint but not the code: ${extra.join(", ")}`);
  return `${column}: ${parts.join("; ")}`;
}

const migrations = readMigrationFiles(MIGRATIONS_DIR);

const COLUMNS = [
  { table: "episodes", column: "status", values: EPISODE_STATUSES },
  { table: "brief_jobs", column: "status", values: BRIEF_JOB_STATES },
  { table: "brief_jobs", column: "stage", values: BRIEF_JOB_STAGES },
] as const;

describe("lifecycle columns match their TypeScript arrays", () => {
  for (const { table, column, values } of COLUMNS) {
    it(`${table}.${column} allows exactly the values in code`, () => {
      const allowed = constraintValues(migrations, table, column);
      expect(describeMismatch(`${table}.${column}`, allowed, values)).toBeNull();
    });
  }
});

describe("the constraint parser", () => {
  const m = (file: string, sql: string): Migration => ({ file, sql });
  const create = m("1.sql", "create table public.t (\n  id int,\n  state text check (state in ('a', 'b'))\n);");

  it("reads an inline check and an added constraint", () => {
    expect(constraintValues([create], "t", "state")).toEqual(["a", "b"]);
    const added = m("2.sql", "alter table public.t add constraint t_state_check check (state in ('a')) not valid;");
    expect(constraintValues([added], "t", "state")).toEqual(["a"]);
  });

  it("takes the last definition in version order, whatever order the files arrive in", () => {
    const later = m("2.sql", "alter table public.t add constraint c check (state in ('a', 'b', 'c'));");
    expect(constraintValues([later, create], "t", "state")).toEqual(["a", "b", "c"]);
  });

  it("ignores commented-out checks and other tables or columns", () => {
    const other = m("2.sql", "-- check (state in ('x'))\ncreate table u (state text check (state in ('y')));");
    expect(constraintValues([create, other], "t", "state")).toEqual(["a", "b"]);
    expect(constraintValues([create], "t", "other")).toBeNull();
  });

  it("reads the constraint a file drops and re-adds, and the last file's version after it", () => {
    const rerun = m(
      "2.sql",
      "alter table public.t drop constraint if exists t_state_check;\nalter table public.t\n  add constraint t_state_check check (state in ('a', 'z')) not valid;\nalter table public.t validate constraint t_state_check;",
    );
    expect(constraintValues([create, rerun], "t", "state")).toEqual(["a", "z"]);
    const replaced = m("3.sql", "alter table public.t drop constraint t_state_check;\nalter table public.t add constraint t_state_check check (state in ('q')) not valid;");
    expect(constraintValues([create, rerun, replaced], "t", "state")).toEqual(["q"]);
  });

  it("fails on a list missing a value and on one with an extra value", () => {
    const allowed = constraintValues([create], "t", "state");
    expect(describeMismatch("t.state", allowed, ["a", "b", "c"])).toBe("t.state: in the code but not the constraint: c");
    expect(describeMismatch("t.state", allowed, ["a"])).toBe("t.state: in the constraint but not the code: b");
    expect(describeMismatch("t.state", allowed, ["b", "a"])).toBeNull();
  });

  it("fails when no constraint is found", () => {
    expect(constraintValues([], "t", "state")).toBeNull();
    expect(describeMismatch("t.state", null, ["a"])).toContain("no CHECK constraint found");
  });
});
