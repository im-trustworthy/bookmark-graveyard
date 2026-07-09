import { createHash, randomBytes } from "crypto";
import { appUrl, env } from "./env";
import { decrypt, encrypt } from "./crypto";
import { db } from "./supabase";

const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const API = "https://api.x.com/2";

export const SCOPES = ["tweet.read", "users.read", "bookmark.read", "offline.access"];

export function callbackUrl(): string {
  return `${appUrl()}/api/auth/callback/x`;
}

// --- PKCE ---

export function generatePkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge, state: randomBytes(16).toString("base64url") };
}

export function authorizeUrl(challenge: string, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: env("X_CLIENT_ID"),
    redirect_uri: callbackUrl(),
    scope: SCOPES.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${AUTHORIZE_URL}?${params}`;
}

// --- Tokens ---

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

async function tokenRequest(body: URLSearchParams): Promise<TokenResponse> {
  const basic = Buffer.from(`${env("X_CLIENT_ID")}:${env("X_CLIENT_SECRET")}`).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`X token request failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

export function exchangeCode(code: string, verifier: string): Promise<TokenResponse> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: callbackUrl(),
      code_verifier: verifier,
      client_id: env("X_CLIENT_ID"),
    })
  );
}

function refreshTokens(refreshToken: string): Promise<TokenResponse> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: env("X_CLIENT_ID"),
    })
  );
}

export async function storeTokens(userId: string, tokens: TokenResponse) {
  const update: Record<string, unknown> = {
    access_token_enc: encrypt(tokens.access_token),
    token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (tokens.refresh_token) update.refresh_token_enc = encrypt(tokens.refresh_token);
  const { error } = await db().from("users").update(update).eq("id", userId);
  if (error) throw new Error(`Failed to store tokens: ${error.message}`);
}

/** Returns a valid access token for the user, refreshing (with rotation) if expired. */
export async function getAccessToken(userId: string): Promise<string> {
  const { data: user, error } = await db()
    .from("users")
    .select("access_token_enc, refresh_token_enc, token_expires_at")
    .eq("id", userId)
    .single();
  if (error || !user) throw new Error("User not found");

  const expiresAt = user.token_expires_at ? new Date(user.token_expires_at).getTime() : 0;
  if (user.access_token_enc && expiresAt > Date.now() + 60_000) {
    return decrypt(user.access_token_enc);
  }
  if (!user.refresh_token_enc) throw new Error("No refresh token — please log in again");
  const tokens = await refreshTokens(decrypt(user.refresh_token_enc));
  await storeTokens(userId, tokens);
  return tokens.access_token;
}

// --- API calls ---

export interface XUser {
  id: string;
  username: string;
  name: string;
  profile_image_url?: string;
}

export async function fetchMe(accessToken: string): Promise<XUser> {
  const res = await fetch(`${API}/users/me?user.fields=profile_image_url`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`GET /users/me failed (${res.status}): ${await res.text()}`);
  return (await res.json()).data;
}

export interface ReferencedTweet {
  type: string;
  id: string;
  text: string | null;
  author_handle: string | null;
}

export interface BookmarkedTweet {
  tweet_id: string;
  author_handle: string | null;
  author_name: string | null;
  text: string;
  tweet_created_at: string | null;
  public_metrics: unknown;
  entities: unknown;
  media: unknown;
  referenced: ReferencedTweet[];
  raw: unknown;
}

/**
 * Paginates the authenticated user's bookmarks (API returns at most the ~800 most
 * recent). Tolerates early pagination stops, which the endpoint is known for.
 */
export async function fetchAllBookmarks(
  accessToken: string,
  xUserId: string
): Promise<BookmarkedTweet[]> {
  const results: BookmarkedTweet[] = [];
  let nextToken: string | undefined;
  let rateLimitWaits = 0;

  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({
      max_results: "100",
      "tweet.fields": "created_at,text,note_tweet,public_metrics,entities,attachments,author_id",
      expansions: "author_id,attachments.media_keys,referenced_tweets.id,referenced_tweets.id.author_id",
      "user.fields": "username,name",
      "media.fields": "type,url,preview_image_url,alt_text,variants,duration_ms",
    });
    if (nextToken) params.set("pagination_token", nextToken);

    const res = await fetch(`${API}/users/${xUserId}/bookmarks?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 429) {
      // Bounded backoff: keep a partial sync rather than hanging the request.
      if (++rateLimitWaits > 2) break;
      const reset = Number(res.headers.get("x-rate-limit-reset")) * 1000;
      const waitMs = Math.min(Math.max(reset - Date.now(), 1000), 30_000);
      await new Promise((r) => setTimeout(r, waitMs));
      page--;
      continue;
    }
    if (!res.ok) {
      // Tolerate partial syncs: keep what we have, surface the error only if empty.
      if (results.length > 0) break;
      throw new Error(`Bookmarks fetch failed (${res.status}): ${await res.text()}`);
    }

    const body = await res.json();
    const users = new Map<string, { username: string; name: string }>(
      (body.includes?.users ?? []).map((u: XUser) => [u.id, u])
    );
    const mediaByKey = new Map<string, unknown>(
      (body.includes?.media ?? []).map((m: { media_key: string }) => [m.media_key, m])
    );
    const includedTweets = new Map<
      string,
      { text?: string; note_tweet?: { text: string }; author_id?: string; entities?: unknown }
    >((body.includes?.tweets ?? []).map((t: { id: string }) => [t.id, t]));

    for (const tweet of body.data ?? []) {
      const author = users.get(tweet.author_id);
      const mediaKeys: string[] = tweet.attachments?.media_keys ?? [];
      const referenced: ReferencedTweet[] = (tweet.referenced_tweets ?? []).map(
        (ref: { type: string; id: string }) => {
          const full = includedTweets.get(ref.id);
          return {
            type: ref.type,
            id: ref.id,
            text: full?.note_tweet?.text ?? full?.text ?? null,
            author_handle: full?.author_id ? (users.get(full.author_id)?.username ?? null) : null,
          };
        }
      );
      results.push({
        tweet_id: tweet.id,
        author_handle: author?.username ?? null,
        author_name: author?.name ?? null,
        // note_tweet carries the full text of long-form posts
        text: tweet.note_tweet?.text ?? tweet.text ?? "",
        tweet_created_at: tweet.created_at ?? null,
        public_metrics: tweet.public_metrics ?? null,
        entities: tweet.entities ?? null,
        media: mediaKeys.map((k) => mediaByKey.get(k)).filter(Boolean),
        referenced,
        raw: { ...tweet, _includes_tweets: referenced.map((r) => r.id) },
      });
    }

    nextToken = body.meta?.next_token;
    if (!nextToken) break;
  }

  return results;
}
