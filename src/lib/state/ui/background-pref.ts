/**
 * The "Stop background" preference in localStorage. Storage can throw (blocked site data, some
 * private windows), and a throw here would break the render that reads it or leave the button
 * label and the video disagreeing, so both directions degrade instead: a failed read means the
 * default (on), a failed write keeps the choice for this page load only.
 */

export const BG_STORAGE_KEY = "bb_bg";

type Reader = Pick<Storage, "getItem">;
type Writer = Pick<Storage, "setItem">;

export function readBackgroundOn(storage: () => Reader): boolean {
  try {
    return storage().getItem(BG_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function writeBackgroundOn(storage: () => Writer, on: boolean): void {
  try {
    storage().setItem(BG_STORAGE_KEY, on ? "on" : "off");
  } catch {
    // Not saved; the in-memory value still drives this page load.
  }
}
