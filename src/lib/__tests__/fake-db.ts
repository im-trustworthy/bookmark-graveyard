// In-memory stand-in for the supabase-js client, covering only the calls this
// app makes: from(table) with select/insert/upsert/update/delete, eq/is/lt and
// not(column, "is", value) filters, order/limit (ignored), then
// maybeSingle()/single() or a plain await; rpc() into Postgres functions the
// test registers in `functions` (an unregistered one errors, as a missing
// function does); plus storage uploads and removals. Like PostgREST,
// select("a, b") returns only those columns (select() or "*" returns all), so
// a column missing from a query's select list reads as undefined in tests too.
// Tests read and seed `tables` directly.

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { message: string } | null };

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
  private columns: string[] | null = null; // null = every column
  private mode: "many" | "single" | "maybeSingle" = "many";
  private filters: ((row: Row) => boolean)[] = [];

  constructor(
    private db: FakeDb,
    private table: string
  ) {}

  select(columns?: string) {
    if (this.op !== "select") this.returning = true;
    this.columns = !columns || columns.trim() === "*" ? null : columns.split(",").map((c) => c.trim());
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
  order() {
    return this;
  }
  limit() {
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
      result = table.filter(matches);
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
    const columns = this.columns;
    const project = (row: Row): Row => (columns ? Object.fromEntries(columns.map((c) => [c, row[c]])) : { ...row });
    if (this.mode === "many") {
      return { data: this.op === "select" || this.returning ? result.map(project) : null, error: null };
    }
    if (this.mode === "single" && result.length !== 1) {
      return { data: null, error: { message: `expected 1 row, got ${result.length}` } };
    }
    return { data: result[0] ? project(result[0]) : null, error: null };
  }
}
