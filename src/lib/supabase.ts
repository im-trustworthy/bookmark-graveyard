import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env";

// Server-only client with service role key (RLS is deny-all; never expose to the browser).
let client: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (!client) {
    client = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false },
    });
  }
  return client;
}
