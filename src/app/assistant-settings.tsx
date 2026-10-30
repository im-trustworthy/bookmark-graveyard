"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { FormEvent, ReactNode, RefObject } from "react";

// The Assistants panel: the MCP connector URL and the personal access tokens an
// AI assistant uses to reach this account. Talks only to the same-origin
// /api/tokens routes. A new token's plaintext lives in component state until
// the person dismisses it or closes the panel; it is never stored or logged,
// and the server can't show it again.

type Scope = "read" | "write";
type Tone = "error" | "ok" | "info";

interface TokenRecord {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  client_id: string | null;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

const NAME_MAX = 60;
const EXPIRY_DAYS = 90;

const SCOPE_CHOICES: { scope: Scope; label: string; description: string }[] = [
  {
    scope: "read",
    label: "Read only",
    description: "Search your bookmarks and topics, and list and open your briefs. Costs nothing.",
  },
  {
    scope: "write",
    label: "Read and write",
    description:
      "Also start new briefs and hide bookmarks. Starting a brief spends your daily brief allowance and your API credits.",
  },
];

// --- Styles: the same pills, fields and muted text the Voices panel uses -----

const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950";

const secondaryButton = `rounded-full border border-white/15 bg-white/5 px-4 py-2 text-sm backdrop-blur-md transition hover:border-white/30 disabled:opacity-50 ${FOCUS}`;
const primaryButton = `rounded-full bg-zinc-100 px-5 py-2 text-sm font-medium text-zinc-950 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`;
const dangerButton = `rounded-full border border-red-800/60 bg-red-500/10 px-4 py-2 text-sm text-red-200 transition hover:border-red-600 disabled:opacity-50 ${FOCUS}`;

// No text-sm: inputs inherit the 16px body size, which keeps iOS Safari from zooming in on focus.
const fieldClass =
  "rounded-lg border border-white/15 bg-zinc-900/50 px-3 py-1.5 text-zinc-100 backdrop-blur-md [color-scheme:dark] placeholder:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500";

// --- Network ----------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** An HTTP failure, with the server's message and status. */
class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

/** fetch, with a plain-language message when the network itself fails. */
async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (init.signal?.aborted) throw err;
    throw new Error("Couldn't reach the server — check your connection and try again.");
  }
}

/** The server's `error` string, or a generic line when the body isn't ours. */
async function errorText(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (isRecord(body) && typeof body.error === "string" && body.error) return body.error;
  } catch {
    // Not JSON (a proxy error page, say).
  }
  return `Something went wrong (${res.status}).`;
}

async function requestJson(
  url: string,
  method: "GET" | "POST" | "DELETE",
  body?: unknown,
  signal?: AbortSignal
): Promise<unknown> {
  const res = await send(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    signal,
  });
  if (!res.ok) throw new RequestError(await errorText(res), res.status);
  return res.json();
}

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof DOMException || err instanceof SyntaxError) return fallback;
  return err instanceof Error && err.message ? err.message : fallback;
}

function parseToken(raw: unknown): TokenRecord | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id || typeof raw.name !== "string") return null;
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  return {
    id: raw.id,
    name: raw.name,
    prefix: text(raw.prefix) ?? "",
    scopes: Array.isArray(raw.scopes) ? raw.scopes.filter((s): s is string => typeof s === "string") : [],
    client_id: text(raw.client_id),
    created_at: text(raw.created_at) ?? "",
    last_used_at: text(raw.last_used_at),
    expires_at: text(raw.expires_at),
    revoked_at: text(raw.revoked_at),
  };
}

async function loadTokens(signal: AbortSignal): Promise<TokenRecord[]> {
  const body = await requestJson("/api/tokens", "GET", undefined, signal);
  const list = isRecord(body) && Array.isArray(body.tokens) ? body.tokens : [];
  return list.map(parseToken).filter((t): t is TokenRecord => t !== null);
}

async function createToken(input: {
  name: string;
  scope: Scope;
  expiresInDays: number | null;
}): Promise<{ token: string; record: TokenRecord }> {
  const body = await requestJson("/api/tokens", "POST", input);
  const record = isRecord(body) ? parseToken(body.record) : null;
  if (!isRecord(body) || typeof body.token !== "string" || !body.token || !record) {
    throw new Error("The server's answer didn't include the new token. Try again.");
  }
  return { token: body.token, record };
}

// --- Pure helpers -----------------------------------------------------------

/** Read-only connector URL; empty during the server render (there is no window there). */
const subscribeNever = () => () => {};
const getOrigin = () => window.location.origin;
const getServerOrigin = () => "";

const isExpired = (t: TokenRecord, now: number) => !!t.expires_at && Date.parse(t.expires_at) <= now;

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown date";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** "Read only · Created Oct 29, 2026 · Never used · No expiry" */
function describeToken(t: TokenRecord, now: number): string {
  const scope = t.scopes.includes("write") ? "Read and write" : "Read only";
  const used = t.last_used_at ? `Last used ${formatDate(t.last_used_at)}` : "Never used";
  const expiry = !t.expires_at
    ? "No expiry"
    : isExpired(t, now)
      ? `Expired ${formatDate(t.expires_at)}`
      : `Expires ${formatDate(t.expires_at)}`;
  return [scope, `Created ${formatDate(t.created_at)}`, used, expiry].join(" · ");
}

/** The collapsed summary, after the leading "Assistants". */
function summarize(live: number): string {
  if (live === 0) return "connect an AI assistant to your bookmarks";
  return `${live} active token${live === 1 ? "" : "s"}`;
}

// --- UI ---------------------------------------------------------------------

/** A live region that is always mounted (so changes are announced) and takes no space when empty. */
function Live({ tone = "info", children }: { tone?: Tone; children?: ReactNode }) {
  const color = tone === "error" ? "text-red-400" : tone === "ok" ? "text-emerald-400" : "text-sky-400";
  return (
    <p aria-live="polite" className={children ? `mt-2 text-sm ${color}` : undefined}>
      {children}
    </p>
  );
}

/**
 * A read-only field with a Copy button. When the clipboard isn't available
 * (an http:// instance on a LAN, a denied permission) the text is selected so
 * it can be copied by hand.
 */
function CopyField({
  value,
  inputLabel,
  copyLabel,
  inputId,
  describedBy,
  buttonRef,
}: {
  value: string;
  inputLabel?: string;
  copyLabel: string;
  inputId?: string;
  describedBy?: string;
  buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState<"copied" | "failed" | null>(null);

  useEffect(() => {
    if (status !== "copied") return;
    const timer = setTimeout(() => setStatus(null), 2500);
    return () => clearTimeout(timer);
  }, [status]);

  async function copy() {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(value);
      setStatus("copied");
    } catch {
      inputRef.current?.focus();
      inputRef.current?.select();
      setStatus("failed");
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          aria-label={inputLabel}
          aria-describedby={describedBy}
          spellCheck={false}
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          className={`${fieldClass} min-w-0 flex-1 basis-48 font-mono`}
        />
        <button
          ref={buttonRef}
          type="button"
          onClick={copy}
          aria-label={copyLabel}
          className={`${secondaryButton} min-w-20 shrink-0`}
        >
          {status === "copied" ? "Copied" : "Copy"}
        </button>
      </div>
      <p aria-live="polite" className={status === "failed" ? "mt-2 text-sm text-red-400" : "sr-only"}>
        {status === "copied"
          ? "Copied to the clipboard."
          : status === "failed"
            ? "Couldn't copy automatically. It's selected, so copy it with your keyboard."
            : null}
      </p>
    </div>
  );
}

export default function AssistantSettings() {
  const uid = useId();
  const origin = useSyncExternalStore(subscribeNever, getOrigin, getServerOrigin);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const listHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const revealCopyRef = useRef<HTMLButtonElement | null>(null);
  const keepRef = useRef<HTMLButtonElement | null>(null);
  // Where focus goes after the next render that removes the focused control.
  const pendingFocus = useRef<"toggle" | "list" | "name" | "reveal" | `revoke:${string}` | null>(null);

  const [tokens, setTokens] = useState<TokenRecord[] | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(() => Date.now()); // refreshed on each load and change, for expiry labels

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<Scope>("read");
  const [expires, setExpires] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ token: string; name: string } | null>(null);

  const [confirming, setConfirming] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<{ id: string; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Load the token list once (and again on Retry) so the collapsed summary is accurate.
  useEffect(() => {
    const ctrl = new AbortController();
    loadTokens(ctrl.signal).then(
      (list) => {
        if (ctrl.signal.aborted) return;
        setTokens(list);
        setNow(Date.now());
        setFetchError(null);
      },
      (err) => {
        if (ctrl.signal.aborted) return;
        setFetchError(messageOf(err, "Couldn't load your tokens."));
      }
    );
    return () => ctrl.abort();
  }, [attempt]);

  // Confirmations are brief.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  // Move focus when the control that had it goes away (or a new step appears).
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    if (target === "toggle") toggleRef.current?.focus();
    else if (target === "list") listHeadingRef.current?.focus();
    else if (target === "name") nameRef.current?.focus();
    else if (target === "reveal") revealCopyRef.current?.focus();
    else document.getElementById(`${uid}-revoke-${target.slice("revoke:".length)}`)?.focus();
  });

  // The "Keep" button is the safe default while a revoke is being confirmed.
  useEffect(() => {
    if (confirming) keepRef.current?.focus();
  }, [confirming]);

  // --- Derived state -------------------------------------------------------

  const shown = (tokens ?? []).filter((t) => !t.revoked_at);
  const live = shown.filter((t) => !isExpired(t, now));
  const connectorUrl = `${origin}/api/mcp`;
  const trimmedName = name.trim();

  // --- Handlers ------------------------------------------------------------

  function openPanel() {
    setNotice(null);
    setNow(Date.now());
    setOpen(true);
  }

  function closePanel() {
    setOpen(false);
    setRevealed(null); // the plaintext goes with the panel
    setName("");
    setScope("read");
    setExpires(false);
    setCreateError(null);
    setConfirming(null);
    setRevokeError(null);
    pendingFocus.current = "toggle";
  }

  async function onCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (creating || !trimmedName) return;
    setCreating(true);
    setCreateError(null);
    try {
      const { token, record } = await createToken({
        name: trimmedName,
        scope,
        expiresInDays: expires ? EXPIRY_DAYS : null,
      });
      setTokens((prev) => [record, ...(prev ?? []).filter((t) => t.id !== record.id)]);
      setNow(Date.now());
      setRevealed({ token, name: record.name });
      setName("");
      setScope("read");
      setExpires(false);
      pendingFocus.current = "reveal";
    } catch (err) {
      setCreateError(messageOf(err, "Couldn't create the token."));
    } finally {
      setCreating(false);
    }
  }

  function dismissReveal() {
    setRevealed(null);
    pendingFocus.current = "name";
  }

  function askRevoke(id: string) {
    setRevokeError(null);
    setConfirming(id);
  }

  function keepToken(id: string) {
    setConfirming(null);
    pendingFocus.current = `revoke:${id}`;
  }

  async function revoke(token: TokenRecord) {
    if (revoking) return;
    setRevoking(token.id);
    setRevokeError(null);
    try {
      await requestJson(`/api/tokens/${encodeURIComponent(token.id)}`, "DELETE");
    } catch (err) {
      // 404: already revoked elsewhere (another tab) — the outcome the person wanted.
      if (!(err instanceof RequestError && err.status === 404)) {
        setRevokeError({ id: token.id, message: messageOf(err, "Couldn't revoke the token.") });
        setRevoking(null);
        return;
      }
    }
    setTokens((prev) => (prev ?? []).filter((t) => t.id !== token.id));
    setConfirming(null);
    setRevoking(null);
    setNotice(`Revoked “${token.name}”. Assistants using it are cut off.`);
    pendingFocus.current = "list";
  }

  // --- Render --------------------------------------------------------------

  const urlId = `${uid}-url`;
  const urlHelpId = `${uid}-url-help`;
  const nameId = `${uid}-name`;
  const nameHelpId = `${uid}-name-help`;
  const listHeadingId = `${uid}-list`;
  const createHeadingId = `${uid}-create`;
  const revealHeadingId = `${uid}-reveal`;
  const revealHelpId = `${uid}-reveal-help`;

  return (
    <section
      aria-label="AI assistants"
      className="rounded-2xl border border-white/10 bg-white/[0.06] p-5 shadow-lg shadow-black/20 backdrop-blur-xl"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1 break-words text-sm text-zinc-400">
          <h2 className={`font-heading tracking-wide text-zinc-100 ${open ? "text-2xl" : "inline text-lg"}`}>
            Assistants
          </h2>
          {!open && (
            <span> · {tokens ? summarize(live.length) : fetchError ? "couldn't load tokens" : "loading…"}</span>
          )}
        </div>
        {tokens ? (
          <button
            ref={toggleRef}
            type="button"
            onClick={open ? closePanel : openPanel}
            aria-expanded={open}
            className={`${secondaryButton} shrink-0`}
          >
            {open ? "Close" : live.length > 0 ? "Manage" : "Set up"}
          </button>
        ) : (
          fetchError && (
            <button
              type="button"
              onClick={() => {
                setFetchError(null);
                setAttempt((n) => n + 1);
              }}
              className={`${secondaryButton} shrink-0`}
            >
              Retry
            </button>
          )
        )}
      </div>

      {open && (
        <div className="mt-4 space-y-6 border-t border-white/10 pt-4">
          <p className="text-sm text-zinc-300">
            Connect an AI assistant to search your bookmarks and make briefs. Assistants that support sign-in (Claude,
            ChatGPT) connect without a token: add the connector URL and approve the access request.
          </p>

          {/* Connector URL */}
          <div className="space-y-2">
            <label htmlFor={urlId} className="block text-sm text-zinc-400">
              Connector URL
            </label>
            <CopyField value={connectorUrl} inputId={urlId} describedBy={urlHelpId} copyLabel="Copy connector URL" />
            <p id={urlHelpId} className="text-xs text-zinc-500">
              Add it as a connector (MCP server) in your assistant, and give it a token from below as the bearer
              token.
            </p>
          </div>

          {/* Tokens */}
          <div className="space-y-2">
            <h3
              id={listHeadingId}
              ref={listHeadingRef}
              tabIndex={-1}
              className="rounded text-sm text-zinc-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
            >
              Your tokens
            </h3>
            {shown.length === 0 ? (
              <p className="text-sm text-zinc-500">No tokens yet. Create one below for each assistant you connect.</p>
            ) : (
              <ul aria-labelledby={listHeadingId} className="space-y-2">
                {shown.map((t) => {
                  const asking = confirming === t.id;
                  const busy = revoking === t.id;
                  const expired = isExpired(t, now);
                  return (
                    <li
                      key={t.id}
                      className={`rounded-xl border p-3 backdrop-blur-md ${
                        asking ? "border-red-400/30 bg-red-500/[0.06]" : "border-white/10 bg-white/[0.04]"
                      }`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="break-words text-sm font-medium text-zinc-100">
                            {t.name}{" "}
                            <span className="font-mono text-xs font-normal text-zinc-500">{t.prefix}…</span>
                            {t.client_id && (
                              <span className="ml-2 rounded-full bg-sky-900/40 px-2 py-0.5 text-[11px] font-normal text-sky-300">
                                Connected by sign-in
                              </span>
                            )}
                            {expired && (
                              <span className="ml-2 rounded-full bg-amber-900/40 px-2 py-0.5 text-[11px] font-normal text-amber-300">
                                Expired
                              </span>
                            )}
                          </p>
                          <p className="mt-1 text-xs text-zinc-500">{describeToken(t, now)}</p>
                        </div>
                        {!asking && (
                          <button
                            id={`${uid}-revoke-${t.id}`}
                            type="button"
                            onClick={() => askRevoke(t.id)}
                            disabled={revoking !== null}
                            aria-label={`Revoke ${t.name}`}
                            className={`${secondaryButton} shrink-0`}
                          >
                            Revoke
                          </button>
                        )}
                      </div>
                      {asking && (
                        <div
                          role="group"
                          aria-label={`Confirm revoking ${t.name}`}
                          className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/10 pt-3"
                        >
                          <p className="w-full text-sm text-zinc-300 sm:w-auto sm:flex-1">
                            Revoke this token? Anything using it stops working right away.
                          </p>
                          <button
                            type="button"
                            onClick={() => revoke(t)}
                            disabled={busy}
                            className={dangerButton}
                          >
                            {busy ? "Revoking…" : "Revoke"}
                          </button>
                          <button
                            ref={keepRef}
                            type="button"
                            onClick={() => keepToken(t.id)}
                            disabled={busy}
                            className={secondaryButton}
                          >
                            Keep
                          </button>
                        </div>
                      )}
                      <Live tone="error">{revokeError?.id === t.id ? revokeError.message : null}</Live>
                    </li>
                  );
                })}
              </ul>
            )}
            <Live tone="ok">{notice}</Live>
          </div>

          {/* One-time reveal, or the create form */}
          {revealed ? (
            <div
              role="region"
              aria-labelledby={revealHeadingId}
              className="space-y-3 rounded-xl border border-emerald-400/25 bg-emerald-500/10 p-4 backdrop-blur-md"
            >
              <h3 id={revealHeadingId} className="break-words text-sm font-medium text-emerald-200">
                Your new token for “{revealed.name}”
              </h3>
              <p id={revealHelpId} className="text-sm text-zinc-300">
                Copy it now; it won&apos;t be shown again.
              </p>
              <CopyField
                value={revealed.token}
                inputLabel={`New token for ${revealed.name}`}
                describedBy={revealHelpId}
                copyLabel="Copy token"
                buttonRef={revealCopyRef}
              />
              <p className="text-xs text-zinc-500">
                Paste it where your assistant asks for a token or API key; it is sent as{" "}
                <code className="font-mono">Authorization: Bearer …</code>.
              </p>
              <button type="button" onClick={dismissReveal} className={secondaryButton}>
                Done
              </button>
            </div>
          ) : (
            <form onSubmit={onCreate} aria-labelledby={createHeadingId} className="space-y-4" noValidate>
              <h3 id={createHeadingId} className="text-sm text-zinc-400">
                Create a token
              </h3>

              <div className="space-y-2">
                <label htmlFor={nameId} className="block text-sm text-zinc-400">
                  Name
                </label>
                <input
                  ref={nameRef}
                  id={nameId}
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={NAME_MAX}
                  autoComplete="off"
                  spellCheck={false}
                  data-1p-ignore
                  data-lpignore="true"
                  placeholder="e.g. Grok"
                  aria-describedby={nameHelpId}
                  className={`${fieldClass} w-full`}
                />
                <p id={nameHelpId} className="text-xs text-zinc-500">
                  So you can tell your tokens apart. Up to {NAME_MAX} characters.
                </p>
              </div>

              <fieldset className="space-y-2">
                <legend className="mb-2 text-sm text-zinc-400">What it can do</legend>
                {SCOPE_CHOICES.map((choice) => {
                  const descId = `${uid}-scope-${choice.scope}`;
                  const checked = scope === choice.scope;
                  return (
                    <label
                      key={choice.scope}
                      className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-sky-500 ${
                        checked ? "border-sky-400/60 bg-sky-400/10" : "border-white/10 bg-white/[0.04] hover:border-white/25"
                      }`}
                    >
                      <input
                        type="radio"
                        name={`${uid}-scope`}
                        value={choice.scope}
                        checked={checked}
                        onChange={() => setScope(choice.scope)}
                        aria-label={choice.label}
                        aria-describedby={descId}
                        className="mt-1 accent-sky-500 focus-visible:outline-none"
                      />
                      <span className="min-w-0">
                        <span className="block text-sm text-zinc-100">{choice.label}</span>
                        <span id={descId} className="block text-xs text-zinc-500">
                          {choice.description}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </fieldset>

              <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-zinc-300">
                <input
                  type="checkbox"
                  checked={expires}
                  onChange={(e) => setExpires(e.target.checked)}
                  className="h-4 w-4 accent-sky-500"
                />
                Expires in {EXPIRY_DAYS} days
              </label>

              <div>
                <button type="submit" disabled={creating || !trimmedName} className={primaryButton}>
                  {creating ? "Creating…" : "Create token"}
                </button>
                <Live tone="error">{createError}</Live>
              </div>
            </form>
          )}
        </div>
      )}
      <Live tone="error">{tokens ? null : fetchError}</Live>
    </section>
  );
}
