import { expect } from "vitest";

// Shared checks for the state-conformance tests. A conformance test drives the real production
// functions, reads the persisted state before and after every step, and hands the moves it saw to
// expectConformance, which holds them against the machine's transitions table in both directions.

export interface Move<S extends string> {
  from: S;
  to: S;
}

/** A table entry the test's fakes cannot produce, with why. */
export interface NotExercised<S extends string> extends Move<S> {
  reason: string;
}

/** The moves a file's scenarios made, in order. */
export class MoveLog<S extends string> {
  readonly moves: Move<S>[] = [];

  /** One step that changed the persisted state from `from` to `to`. */
  record(from: S, to: S): void {
    this.moves.push({ from, to });
  }
}

const key = (move: Move<string>) => `${move.from} -> ${move.to}`;

/** Every (from, to) entry of a transitions table. */
export function tableEntries<S extends string>(table: Readonly<Record<S, readonly S[]>>): string[] {
  return (Object.entries(table) as [S, readonly S[]][]).flatMap(([from, targets]) => targets.map((to) => key({ from, to })));
}

/**
 * Soundness: every observed move is one the table allows. Coverage: every table entry was observed, or is
 * listed in `notExercised` (which may name only entries the table has and the scenarios did not make).
 */
export function expectConformance<S extends string>(spec: {
  transitions: Readonly<Record<S, readonly S[]>>;
  canMove: (from: S, to: S) => boolean;
  moves: readonly Move<S>[];
  notExercised?: readonly NotExercised<S>[];
}): void {
  const { transitions, canMove, moves, notExercised = [] } = spec;
  const entries = tableEntries(transitions);
  const observed = [...new Set(moves.map(key))];
  const excused = notExercised.map(key);

  expect(moves.filter((move) => !canMove(move.from, move.to)).map(key), "moves the table does not allow").toEqual([]);
  expect(excused.filter((entry) => !entries.includes(entry)), "excused entries that are not in the table").toEqual([]);
  expect(excused.filter((entry) => observed.includes(entry)), "excused entries the scenarios do observe").toEqual([]);
  expect(
    entries.filter((entry) => !observed.includes(entry) && !excused.includes(entry)),
    "table entries no scenario observed"
  ).toEqual([]);
  expect([...observed, ...excused].sort()).toEqual([...entries].sort());
}
