import { describe, expect, it } from "vitest";
import { BG_STORAGE_KEY, readBackgroundOn, writeBackgroundOn } from "../state/ui/background-pref";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

const blocked = () => {
  throw new Error("SecurityError: storage is blocked");
};

describe("background preference", () => {
  it("reads on unless off was saved", () => {
    expect(readBackgroundOn(() => memoryStorage())).toBe(true);
    expect(readBackgroundOn(() => memoryStorage({ [BG_STORAGE_KEY]: "on" }))).toBe(true);
    expect(readBackgroundOn(() => memoryStorage({ [BG_STORAGE_KEY]: "off" }))).toBe(false);
  });

  it("saves the choice", () => {
    const s = memoryStorage();
    writeBackgroundOn(() => s, false);
    expect(s.data.get(BG_STORAGE_KEY)).toBe("off");
    writeBackgroundOn(() => s, true);
    expect(s.data.get(BG_STORAGE_KEY)).toBe("on");
  });

  it("degrades instead of throwing when storage is blocked", () => {
    expect(readBackgroundOn(blocked)).toBe(true);
    expect(readBackgroundOn(() => ({ getItem: blocked }))).toBe(true);
    expect(() => writeBackgroundOn(blocked, false)).not.toThrow();
    expect(() => writeBackgroundOn(() => ({ setItem: blocked }), false)).not.toThrow();
  });
});
