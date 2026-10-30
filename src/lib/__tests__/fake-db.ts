// In-memory stand-in for the supabase-js client, covering only the calls this
// app makes: from(table) with select/insert/upsert/update/delete, eq/is/lt and
// not(column, "is", value) filters, order/limit (applied to selects, nulls
// placed as Postgres does), then
// maybeSingle()/single() or a plain await; rpc() into Postgres functions the
// test registers in `functions` (an unregistered one errors, as a missing
// function does); plus storage uploads and removals. Like PostgREST,
// select("a, b") returns only those columns (select() or "*" returns all), so
// a column missing from a query's select list reads as undefined in tests too.
// An embedded resource, select("a, rel(b, c)"), reads the row's own `rel`
// field (a test seeds the joined object or array inline) narrowed to b and c.
// select(columns, { count: "exact", head: true }) answers the matching row
// count, with no rows when `head` is set.
// Tests read and seed `tables` directly.

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { message: string } | null; count?: number | null };
/** One entry of a select list: a column, or an embedded resource with its own list. */
type Column = { name: string; inner: Column[] | null };

/** Parses a PostgREST select list, keeping `rel(a, b)` groups together. */
function parseColumns(list: string): Column[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of list) {
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    current += ch;
  }
  parts.push(current);
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const open = part.indexOf("(");
      if (open < 0 || !part.endsWith(")")) return { name: part, inner: null };
      return { name: part.slice(0, open).trim(), inner: parseColumns(part.slice(open + 1, -1)) };
    });
}

function projectRow(row: Row, columns: Column[]): Row {
  return Object.fromEntries(
    columns.map(({ name, inner }) => {
      const value = row[name];
      if (!inner || value === null || value === undefined) return [name, value];
      if (Array.isArray(value)) return [name, value.map((v) => projectRow(v as Row, inner))];
      return [name, projectRow(value as Row, inner)];
    })
  );
}

export interface FakeDb {
  tables: Record<string, Row[]>;
  uploads: { bucket: string; path: string }[];
  /** One entry per storage remove() call. */
  removals: { bucket: string; paths: string[] }[];
  /** What rpc(name, args) returns as data, by function name. */
  functions: Record<string, (args: Record<string, unknown>) => unknown>;
  from(table: string): FakeQuery;
  rpc(fn: string, args?: Record<string, unknown>): Promise<Result>;
  storage: {
    from(bucket: string): {
      upload(path: string): Promise<{ error: null }>;
      remove(paths: string[]): Promise<Result>;
    };
  };
}

export function createFakeDb(tables: Record<string, Row[]> = {}): FakeDb {
  const db: FakeDb = {
    tables,
    uploads: [],
    removals: [],
    functions: {},
    from: (table) => new FakeQuery(db, table),
    rpc: async (fn, args = {}) => {
      const body = db.functions[fn];
      if (!body) return { data: null, error: { message: `Could not find the function public.${fn}` } };
      return { data: body(args), error: null };
    },
    storage: {
      from: (bucket) => ({
        upload: async (path) => {
          db.uploads.push({ bucket, path });
          return { error: null };
        },
        remove: async (paths) => {
          db.removals.push({ bucket, paths });
          return { data: paths.map((name) => ({ name })), error: null };
        },
      }),
    },
  };
  return db;
}

class FakeQuery implements PromiseLike<Result> {
  private op: "select" | "insert" | "upsert" | "update" | "delete" = "select";
  private rows: Row[] = [];
  private patch: Row = {};
  private conflictKey?: string;
  private returning = false;
  private columns: Column[] | null = null; // null = every column
  private counting = false;
  private head = false;
  private mode: "many" | "single" | "maybeSingle" = "many";
  private filters: ((row: Row) => boolean)[] = [];
  private sorts: { column: string; ascending: boolean; nullsFirst: boolean }[] = [];
  private max: number | null = null;

  constructor(
    private db: FakeDb,
    private table: string
  ) {}

  select(columns?: string, options: { count?: "exact"; head?: boolean } = {}) {
    if (this.op !== "select") this.returning = true;
    this.columns = !columns || columns.trim() === "*" ? null : parseColumns(columns);
    this.counting = options.count === "exact";
    this.head = options.head === true;
    return this;
  }
  insert(rows: Row | Row[]) {
    this.op = "insert";
    this.rows = [rows].flat();
    return this;
  }
  upsert(rows: Row | Row[], options?: { onConflict?: string }) {
    this.op = "upsert";
    this.rows = [rows].flat();
    this.conflictKey = options?.onConflict;
    return this;
  }
  update(patch: Row) {
    this.op = "update";
    this.patch = patch;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters.push((row) => row[column] === value);
    return this;
  }
  is(column: string, value: unknown) {
    this.filters.push((row) => (row[column] ?? null) === value);
    return this;
  }
  lt(column: string, value: number) {
    this.filters.push((row) => (row[column] as number) < value);
    return this;
  }
  not(column: string, operator: "is", value: unknown) {
    this.filters.push((row) => (row[column] ?? null) !== value);
    return this;
  }
  order(column: string, options: { ascending?: boolean; nullsFirst?: boolean } = {}) {
    const ascending = options.ascending ?? true;
    // Postgres puts nulls last ascending and first descending unless told otherwise.
    this.sorts.push({ column, ascending, nullsFirst: options.nullsFirst ?? !ascending });
    return this;
  }
  limit(count: number) {
    this.max = count;
    return this;
  }
  maybeSingle() {
    this.mode = "maybeSingle";
    return this;
  }
  single() {
    this.mode = "single";
    return this;
  }

  then<A = Result, B = never>(
    onfulfilled?: ((value: Result) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null
  ): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }

  private run(): Result {
    const table = (this.db.tables[this.table] ??= []);
    const matches = (row: Row) => this.filters.every((f) => f(row));
    let result: Row[];
    if (this.op === "select") {
      result = this.sorted(table.filter(matches));
      // Like PostgREST's count=exact: every matching row, whatever the limit.
      if (this.counting) {
        const count = result.length;
        if (this.head) return { data: null, error: null, count };
        if (this.max !== null) result = result.slice(0, this.max);
        return { ...this.shaped(result), count };
      }
      if (this.max !== null) result = result.slice(0, this.max);
    } else if (this.op === "insert") {
      result = this.rows.map((row) => ({ id: `${this.table}-${table.length + 1}`, ...row }));
      table.push(...result);
    } else if (this.op === "upsert") {
      result = this.rows.map((row) => {
        const key = this.conflictKey;
        const i = key ? table.findIndex((existing) => existing[key] === row[key]) : -1;
        if (i < 0) return table[table.push({ ...row }) - 1];
        return (table[i] = { ...table[i], ...row });
      });
    } else if (this.op === "update") {
      result = table.filter(matches);
      for (const row of result) Object.assign(row, this.patch);
    } else {
      result = table.filter(matches);
      this.db.tables[this.table] = table.filter((row) => !matches(row));
    }
    return this.shaped(result);
  }

  /** The rows as the caller asked for them: projected to the select list, as a list or a single row. */
  private shaped(result: Row[]): Result {
    const columns = this.columns;
    const project = (row: Row): Row => (columns ? projectRow(row, columns) : { ...row });
    if (this.mode === "many") {
      return { data: this.op === "select" || this.returning ? result.map(project) : null, error: null };
    }
    if (this.mode === "single" && result.length !== 1) {
      return { data: null, error: { message: `expected 1 row, got ${result.length}` } };
    }
    return { data: result[0] ? project(result[0]) : null, error: null };
  }

  private sorted(rows: Row[]): Row[] {
    if (this.sorts.length === 0) return rows;
    return [...rows].sort((a, b) => {
      for (const { column, ascending, nullsFirst } of this.sorts) {
        const x = a[column] ?? null;
        const y = b[column] ?? null;
        if (x === y) continue;
        if (x === null) return nullsFirst ? -1 : 1;
        if (y === null) return nullsFirst ? 1 : -1;
        return (x < y ? -1 : 1) * (ascending ? 1 : -1);
      }
      return 0;
    });
  }
}
