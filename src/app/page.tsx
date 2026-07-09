import { getSessionUserId } from "@/lib/session";
import { db } from "@/lib/supabase";
import Dashboard from "./dashboard";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  let user: { handle: string; display_name: string | null; avatar_url: string | null } | null =
    null;
  try {
    const userId = await getSessionUserId();
    if (userId) {
      const { data } = await db()
        .from("users")
        .select("handle, display_name, avatar_url")
        .eq("id", userId)
        .single();
      user = data;
    }
  } catch {
    // Env not configured yet — fall through to the landing page.
  }

  if (user) return <Dashboard user={user} />;

  return (
    <main className="min-h-screen flex items-center justify-center bg-zinc-950 text-zinc-100 px-6">
      <div className="max-w-md text-center space-y-6">
        <div className="text-5xl">🎧</div>
        <h1 className="text-3xl font-semibold tracking-tight">Bookmark Brief</h1>
        <p className="text-zinc-400 leading-relaxed">
          Your X bookmarks, turned into a weekly podcast. Sign in, pick a date range and topics,
          and get a markdown summary or a two-host audio brief — fact-checked against Community
          Notes, with stale news filtered out.
        </p>
        {error === "not_allowed" && (
          <p className="text-amber-400 text-sm">
            This account isn&apos;t on the allowlist for this instance.
          </p>
        )}
        {error === "auth_failed" && (
          <p className="text-red-400 text-sm">
            Sign-in didn&apos;t complete — please try again. (If this keeps happening, check the
            X app credentials in .env.local.)
          </p>
        )}
        <a
          href="/api/auth/login"
          className="inline-block bg-zinc-100 text-zinc-950 font-medium px-6 py-3 rounded-full hover:bg-white transition"
        >
          Sign in with X
        </a>
      </div>
    </main>
  );
}
