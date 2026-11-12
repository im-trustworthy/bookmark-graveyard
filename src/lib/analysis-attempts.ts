import "server-only";
import { db } from "./supabase";

// Whether bookmarks.analysis_attempts exists. The column arrives with a migration, and the code runs on
// databases that have it and on ones that don't yet: without it the analysis pass neither counts nor
// gives up, exactly as before the column existed. Every use of the column asks here first.

/** Postgres's undefined_column, which PostgREST passes through when a select names a missing column. */
const UNDEFINED_COLUMN = "42703";

// Only a yes is remembered: a no is asked again on every call, so a running server picks the column up
// as soon as the migration is applied, without a restart.
let present = false;

/** True once bookmarks.analysis_attempts can be read. Any error other than a missing column is thrown. */
export async function hasAnalysisAttempts(): Promise<boolean> {
  if (present) return true;
  const { error } = await db().from("bookmarks").select("analysis_attempts").limit(1);
  if (!error) {
    present = true;
    return true;
  }
  if (error.code === UNDEFINED_COLUMN) return false;
  throw new Error(`Checking for bookmarks.analysis_attempts failed: ${error.message}`);
}
