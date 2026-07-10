import Image from "next/image";
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
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-zinc-950 px-6 text-zinc-100">
      {/* Background video. muted + playsInline are required for mobile autoplay
          (iOS/Android block un-muted autoplay); loop keeps it running; object-cover
          scales/crops it to fill any viewport (phone, tablet, desktop). Hidden for
          prefers-reduced-motion users — the zinc/gradient backdrop remains. */}
      <video
        aria-hidden="true"
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        disablePictureInPicture
        className="pointer-events-none absolute inset-0 h-full w-full object-cover motion-reduce:hidden"
      >
        <source src="/homepage.mp4" type="video/mp4" />
      </video>
      {/* Scrim + accent glow above the video so the copy stays readable */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-zinc-950/70" />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_rgba(14,165,233,0.14),_transparent_60%)]"
      />
      <div className="relative max-w-md space-y-8 text-center">
        {/* Visible branding is the wordmark image; keep a screen-reader heading */}
        <h1 className="sr-only">Bookmark Graveyard</h1>
        {/* Fixed 320px on every viewport (fits a 375px phone inside the px-6
            gutters) so the mark reads as a stamp, not a banner. */}
        <Image
          src="/logo.jpg"
          alt="Bookmark Graveyard"
          width={320}
          height={160}
          priority
          className="mx-auto w-[320px] border-[6px] border-black shadow-2xl shadow-black/70"
        />
        <p className="text-lg tracking-wide text-zinc-300">
          Raise your bookmarks from the dead.
        </p>
        {error === "not_allowed" && (
          <p className="rounded-xl border border-amber-800/60 bg-amber-950/20 px-4 py-3 text-sm text-amber-300">
            This account isn&apos;t on the allowlist for this instance.
          </p>
        )}
        {error === "auth_failed" && (
          <p className="rounded-xl border border-red-900/60 bg-red-950/20 px-4 py-3 text-sm text-red-300">
            Sign-in didn&apos;t complete — please try again. (If this keeps happening, check the
            X app credentials in .env.local.)
          </p>
        )}
        <a
          href="/api/auth/login"
          className="inline-flex items-center justify-center gap-2 rounded-full bg-zinc-100 px-6 py-3 font-medium text-zinc-950 transition hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
        >
          Sign in with X
        </a>
      </div>
    </main>
  );
}
