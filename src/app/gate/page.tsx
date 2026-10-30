import { safeReturnPath } from "@/lib/return-path";

// Password wall shown by src/proxy.ts to anyone without the gate cookie.
// Deliberately spare — no wordmark, no product copy — so the URL gives away
// nothing about what lives behind it. `next` (the blocked path the proxy
// remembered) rides along in the form so /api/gate can return there.
export default async function Gate({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string | string[] }>;
}) {
  const { error, next: rawNext } = await searchParams;
  const next = safeReturnPath(rawNext);

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-950 px-6 text-zinc-100">
      <div className="w-full max-w-xs space-y-6 text-center">
        <h1 className="font-metal text-4xl text-white [text-shadow:0_0_18px_rgba(56,189,248,0.4)]">
          Who goes there?
        </h1>
        {error && (
          <p className="rounded-xl border border-red-900/60 bg-red-950/20 px-4 py-3 text-sm text-red-300">
            That&apos;s not it — try again.
          </p>
        )}
        <form method="POST" action="/api/gate" className="space-y-3">
          {next && <input type="hidden" name="next" value={next} />}
          <input
            type="password"
            name="password"
            required
            autoFocus
            autoComplete="current-password"
            aria-label="Password"
            placeholder="Password"
            className="w-full rounded-full border border-zinc-700 bg-zinc-900 px-5 py-3 text-center text-zinc-100 placeholder:text-zinc-500 focus:border-sky-400 focus:outline-none"
          />
          <button
            type="submit"
            className="w-full rounded-full bg-zinc-100 px-7 py-3 font-heading text-lg tracking-wide text-zinc-950 transition hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
          >
            Enter
          </button>
        </form>
      </div>
    </main>
  );
}
