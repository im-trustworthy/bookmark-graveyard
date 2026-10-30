import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { checkAuthorizeRequest, loginUrl, sealConsent } from "@/lib/oauth";
import type { AuthorizeRequest } from "@/lib/oauth";
import { getSessionUserId } from "@/lib/session";
import { db } from "@/lib/supabase";

// The consent step of the OAuth flow. GET /oauth/authorize validates the
// request and sends the browser here with the same query; this page checks it
// again (anyone can open this URL directly), makes sure someone is signed in,
// and asks them. The form posts one hidden field, an HMAC-signed blob of the
// validated request and the user that expires in ten minutes, to
// /api/oauth/decision, which checks everything once more. The page never
// redirects to the client itself.

export const metadata: Metadata = {
  title: "Connect an app · Bookmark Graveyard",
  robots: { index: false, follow: false },
};

type SearchParams = Record<string, string | string[] | undefined>;

function toSearchParams(raw: SearchParams): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    for (const item of [value ?? []].flat()) params.append(key, item);
  }
  return params;
}

/** Where the user lands after deciding: the redirect URI's host, or its scheme for an app link. */
function destination(redirectUri: string): string {
  const url = new URL(redirectUri);
  return url.protocol === "https:" || url.protocol === "http:" ? url.host : url.protocol.replace(/:$/, "");
}

const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-950 px-6 py-12 text-zinc-100">
      <div className="w-full max-w-md space-y-6">
        <p className="text-center text-xs uppercase tracking-[0.2em] text-zinc-500">Bookmark Graveyard</p>
        {children}
      </div>
    </main>
  );
}

function Problem({ message }: { message: string }) {
  return (
    <Shell>
      <div className="space-y-3 rounded-2xl border border-red-900/60 bg-red-950/20 p-6">
        <h1 className="font-heading text-2xl tracking-wide text-white">This request can&apos;t be completed</h1>
        <p className="text-sm text-red-200">{message}</p>
        <p className="text-sm text-zinc-400">Go back to the app you came from and add the connector again.</p>
      </div>
    </Shell>
  );
}

function Consent({ request, handle, consent }: { request: AuthorizeRequest; handle: string; consent: string }) {
  const canWrite = request.scopes.includes("write");
  return (
    <Shell>
      <div className="space-y-5 rounded-2xl border border-white/10 bg-white/[0.06] p-6 shadow-lg shadow-black/20">
        <h1 className="break-words font-heading text-3xl tracking-wide text-white">Connect {request.clientName}?</h1>
        <div className="space-y-2">
          <p className="break-words text-zinc-200">{request.clientName} wants to:</p>
          <ul className="list-disc space-y-1 pl-5 text-zinc-300">
            <li>search and read your bookmarks and briefs</li>
            {canWrite && (
              <li>also start briefs, which spends your daily allowance and credits, and hide bookmarks</li>
            )}
          </ul>
        </div>
        <p className="text-sm text-zinc-400">
          Signed in as <span className="font-medium text-zinc-100">@{handle}</span>. After you choose, you&apos;ll go
          back to <span className="break-all font-medium text-zinc-100">{destination(request.redirectUri)}</span>.
        </p>
        <p className="text-xs text-zinc-500">
          Only approve apps you added yourself. You can disconnect it at any time in the Assistants panel.
        </p>
        <form method="POST" action="/api/oauth/decision" className="flex flex-wrap gap-3">
          <input type="hidden" name="consent" value={consent} />
          <button
            type="submit"
            name="decision"
            value="approve"
            className={`rounded-full bg-zinc-100 px-7 py-3 font-heading text-lg tracking-wide text-zinc-950 transition hover:bg-white ${FOCUS}`}
          >
            Approve
          </button>
          <button
            type="submit"
            name="decision"
            value="deny"
            className={`rounded-full border border-white/15 bg-white/5 px-7 py-3 text-lg transition hover:border-white/30 ${FOCUS}`}
          >
            Deny
          </button>
        </form>
      </div>
    </Shell>
  );
}

export default async function ConsentPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = toSearchParams(await searchParams);

  let check;
  try {
    check = await checkAuthorizeRequest(params);
  } catch (err) {
    console.error("/oauth/authorize/consent:", err);
    return <Problem message="Something went wrong on our side. Try again in a minute." />;
  }
  // Only reachable by opening this URL by hand: /oauth/authorize answers these itself.
  if (!check.ok) return <Problem message="The connection request isn't valid." />;

  const userId = await getSessionUserId();
  // Outside any try: redirect() works by throwing.
  if (!userId) redirect(loginUrl(`/oauth/authorize?${params}`));

  let handle: string | null = null;
  try {
    const { data, error } = await db().from("users").select("handle, is_allowed").eq("id", userId).maybeSingle();
    if (error) throw new Error(error.message);
    if (data?.is_allowed && typeof data.handle === "string") handle = data.handle;
  } catch (err) {
    console.error("/oauth/authorize/consent: user lookup failed:", err);
    return <Problem message="Something went wrong on our side. Try again in a minute." />;
  }
  if (!handle) return <Problem message="Your account can't use this Bookmark Graveyard." />;

  return <Consent request={check.request} handle={handle} consent={sealConsent(check.request, userId)} />;
}
