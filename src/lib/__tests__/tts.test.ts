import { describe, expect, it } from "vitest";
import { estimateDurationSeconds } from "../tts";
import type { ScriptLine } from "../brain";

function line(speaker: ScriptLine["speaker"], text: string): ScriptLine {
  return { speaker, line: text };
}

describe("estimateDurationSeconds", () => {
  it("returns 0 for no lines", () => {
    expect(estimateDurationSeconds([])).toBe(0);
  });

  it("estimates at a rate of 150 words per minute", () => {
    const words = Array(150).fill("word").join(" ");
    expect(estimateDurationSeconds([line("A", words)])).toBe(60);
  });

  it("sums word counts across multiple lines/speakers", () => {
    const lines = [line("A", Array(75).fill("word").join(" ")), line("B", Array(75).fill("word").join(" "))];
    expect(estimateDurationSeconds(lines)).toBe(60);
  });

  it("rounds to the nearest second", () => {
    // 77 words -> 77/150*60 = 30.8s -> rounds to 31
    const words = Array(77).fill("word").join(" ");
    expect(estimateDurationSeconds([line("A", words)])).toBe(31);
  });

  it("ignores leading/trailing whitespace when counting words", () => {
    // Regression test: `split(/\s+/)` yields a leading "" element for strings
    // starting with whitespace; the estimator must filter those out.
    const withLeadingSpace = estimateDurationSeconds([line("A", " hello")]);
    const withoutLeadingSpace = estimateDurationSeconds([line("A", "hello")]);
    expect(withLeadingSpace).toBe(withoutLeadingSpace);
  });

  it("counts empty lines as zero words", () => {
    const tenEmptyLines: ScriptLine[] = Array.from({ length: 10 }, () => line("A", ""));
    expect(estimateDurationSeconds(tenEmptyLines)).toBe(0);
    expect(estimateDurationSeconds([])).toBe(0);
  });
});
