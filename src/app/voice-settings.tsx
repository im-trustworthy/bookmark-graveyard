"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";

// Podcast voice settings: connect Grok Voice or ElevenLabs, then choose both
// host voices by ear. Talks only to the same-origin /api/voice/* routes. Nothing
// is kept in browser storage; a typed API key lives in component state only
// until it is saved or the panel is closed, and is never logged.

type Provider = "grok" | "elevenlabs";
type Host = "A" | "B";
type Tone = "error" | "ok" | "info";

interface Voice {
  id: string;
  name: string;
  gender: "female" | "male" | null;
  kind: "builtin" | "custom";
}

interface Settings {
  provider: Provider | null;
  source: "user" | "instance" | "none";
  voiceA: string | null;
  voiceB: string | null;
  ownKey: boolean;
  keyHint: string | null;
  instance: { grok: boolean; elevenlabs: boolean; provider: Provider | null };
}

/** A voices fetch; key "" means the stored or instance key. */
interface VoiceRequest {
  provider: Provider;
  key: string;
}

const NOT_SET_UP: Settings = {
  provider: null,
  source: "none",
  voiceA: null,
  voiceB: null,
  ownKey: false,
  keyHint: null,
  instance: { grok: false, elevenlabs: false, provider: null },
};

const PROVIDER_LABEL: Record<Provider, string> = { grok: "Grok Voice", elevenlabs: "ElevenLabs" };
const PROVIDERS = Object.keys(PROVIDER_LABEL) as Provider[];

const HOSTS: { host: Host; label: string }[] = [
  { host: "A", label: "Host A — Alex, the curious host" },
  { host: "B", label: "Host B — Blake, the analyst" },
];

// --- Styles: the same pills, fields and muted text the dashboard uses -------

const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950";

// Identical to the format picker's toggle pills.
const pillClass = (active: boolean) =>
  `rounded-full border px-4 py-2 text-sm transition ${FOCUS} ${
    active
      ? "border-zinc-100 bg-zinc-100 font-medium text-zinc-950"
      : "border-white/15 bg-white/5 backdrop-blur-md hover:border-white/30"
  }`;

// Same as the header's Re-sync button.
const secondaryButton = `rounded-full border border-white/15 bg-white/5 px-4 py-2 text-sm backdrop-blur-md transition hover:border-white/30 disabled:opacity-50 ${FOCUS}`;
const primaryButton = `rounded-full bg-zinc-100 px-5 py-2 text-sm font-medium text-zinc-950 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`;

// Same as the date inputs. No text-sm: inputs inherit the 16px body size, which
// keeps iOS Safari from zooming in on focus.
const fieldClass =
  "rounded-lg border border-white/15 bg-zinc-900/50 px-3 py-1.5 text-zinc-100 backdrop-blur-md [color-scheme:dark] placeholder:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500";
const optionClass = "bg-zinc-900 text-zinc-100";

// --- Network ----------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

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
  method: "GET" | "POST" | "PUT" | "DELETE",
  body?: unknown,
  signal?: AbortSignal
): Promise<unknown> {
  const res = await send(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: method === "GET" ? "no-store" : undefined,
    signal,
  });
  if (!res.ok) throw new Error(await errorText(res));
  return res.json();
}

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof DOMException || err instanceof SyntaxError) return fallback;
  return err instanceof Error && err.message ? err.message : fallback;
}

function parseSettings(raw: unknown): Settings {
  const r = (isRecord(raw) ? raw : {}) as Partial<Settings>;
  return { ...NOT_SET_UP, ...r, instance: { ...NOT_SET_UP.instance, ...r.instance } };
}

async function loadSettings(signal: AbortSignal): Promise<Settings> {
  return parseSettings(await requestJson("/api/voice/settings", "GET", undefined, signal));
}

async function fetchVoices({ provider, key }: VoiceRequest, signal: AbortSignal): Promise<Voice[]> {
  const body = await requestJson("/api/voice/voices", "POST", key ? { provider, apiKey: key } : { provider }, signal);
  const list = isRecord(body) && Array.isArray(body.voices) ? body.voices : [];
  const voices = list.filter((v): v is Voice => isRecord(v) && typeof v.id === "string" && v.id !== "");
  if (voices.length === 0) throw new Error("No voices came back for this account.");
  return voices;
}

// --- Pure helpers -----------------------------------------------------------

/** The vendor the panel starts on: the one in effect, else any the instance has a key for. */
function effectiveProvider(s: Settings): Provider {
  return s.provider ?? s.instance.provider ?? (s.instance.elevenlabs && !s.instance.grok ? "elevenlabs" : "grok");
}

/** Whether a key can be found for this vendor: typed, the user's own, or the instance's. */
function keyAvailable(s: Settings, provider: Provider, typedKey: string): boolean {
  return !!typedKey || (s.ownKey && s.provider === provider) || s.instance[provider];
}

/** The voice a select shows: the user's pick, else what is saved, else the first female (A) / male (B). */
function chooseVoice(voices: Voice[], host: Host, picked?: string, saved?: string | null): string {
  const has = (id?: string | null): id is string => !!id && voices.some((v) => v.id === id);
  if (has(picked)) return picked;
  if (has(saved)) return saved;
  const byGender = voices.find((v) => v.gender === (host === "A" ? "female" : "male"));
  return (byGender ?? (host === "A" ? voices[0] : (voices[1] ?? voices[0]))).id;
}

/** A readable name for a voice id, or null when all we have is an opaque id. */
function knownName(provider: Provider, id: string | null, names: Record<string, string>): string | null {
  if (!id) return null;
  if (names[`${provider}:${id}`]) return names[`${provider}:${id}`];
  // Built-in ids are lowercase slugs ("ara"); ElevenLabs ids are mixed-case noise.
  if (!/^[a-z][a-z0-9_-]{1,23}$/.test(id)) return null;
  return id
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

/** The collapsed summary, after the leading "Voices". */
function describe(s: Settings, names: Record<string, string>): string {
  if (s.source === "none" || !s.provider) return "not set up — audio briefs unavailable";
  const a = knownName(s.provider, s.voiceA, names);
  const b = knownName(s.provider, s.voiceB, names);
  const voices = a && b ? `${a} & ${b}` : s.source === "user" ? "selected voices" : "default voices";
  const key = s.ownKey ? `your key${s.keyHint ? ` ••••${s.keyHint}` : ""}` : "this instance's key";
  return `${PROVIDER_LABEL[s.provider]} · ${voices} · ${key}`;
}

// --- Preview player ---------------------------------------------------------

/** loading = fetching the sample · tap = the browser blocked autoplay, so the controls are shown */
type PreviewState =
  | { host: Host; phase: "loading" | "playing" | "tap" }
  | { host: Host; phase: "error"; message: string };

const PREVIEW_NOTE = { loading: "Loading sample…", playing: "Playing…", tap: "Tap play to hear it." };

/**
 * One shared <audio> element for every preview. Starting, stopping or
 * unmounting always goes through release(), which cancels the fetch, drops the
 * element's source and revokes the blob URL, so object URLs never pile up.
 * `run` is bumped on every release so a response that arrives late is ignored.
 */
function usePreview(audioRef: RefObject<HTMLAudioElement | null>) {
  const urlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runRef = useRef(0);
  const [state, setState] = useState<PreviewState | null>(null);

  const release = useCallback(() => {
    runRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    const audio = audioRef.current;
    if (audio?.getAttribute("src")) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, [audioRef]);

  useEffect(() => release, [release]); // unmount: stop everything

  const stop = useCallback(() => {
    release();
    setState(null);
  }, [release]);

  const play = useCallback(
    async (host: Host, req: { provider: Provider; voiceId: string; apiKey: string }) => {
      release();
      const run = runRef.current;
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setState({ host, phase: "loading" });
      try {
        const res = await send("/api/voice/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: req.provider,
            voiceId: req.voiceId,
            ...(req.apiKey ? { apiKey: req.apiKey } : {}),
          }),
          signal: ctrl.signal,
        });
        if (!res.ok || (res.headers.get("content-type") ?? "").includes("application/json")) {
          throw new Error(await errorText(res));
        }
        const blob = await res.blob();
        if (run !== runRef.current) return; // stopped or replaced while downloading
        if (blob.size === 0) throw new Error("The preview came back empty.");
        const audio = audioRef.current;
        if (!audio) return;
        urlRef.current = URL.createObjectURL(blob);
        audio.src = urlRef.current;
        await audio.play();
      } catch (err) {
        if (run !== runRef.current) return; // aborted or replaced: not an error
        if (err instanceof DOMException && err.name === "NotAllowedError") {
          // Some browsers (iOS Safari) only allow play() inside the tap itself, not after a fetch.
          setState({ host, phase: "tap" });
          return;
        }
        release();
        setState({ host, phase: "error", message: messageOf(err, "Couldn't play that sample.") });
      }
    },
    [release, audioRef]
  );

  return {
    state,
    play,
    stop,
    onPlaying: () =>
      setState((s) => (s && (s.phase === "loading" || s.phase === "tap") ? { host: s.host, phase: "playing" } : s)),
    onEnded: stop,
    onError: () => {
      if (!audioRef.current?.getAttribute("src")) return; // we cleared it on purpose
      const host = state?.host;
      release();
      setState(host ? { host, phase: "error", message: "Couldn't play that sample." } : null);
    },
  };
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

function VoiceOptions({ voices }: { voices: Voice[] }) {
  const option = (v: Voice) => (
    <option key={v.id} value={v.id} className={optionClass}>
      {v.gender ? `${v.name || v.id} · ${v.gender}` : v.name || v.id}
    </option>
  );
  const builtin = voices.filter((v) => v.kind !== "custom");
  const custom = voices.filter((v) => v.kind === "custom");
  return (
    <>
      {builtin.length > 0 && (
        <optgroup label="Built-in" className={optionClass}>
          {builtin.map(option)}
        </optgroup>
      )}
      {custom.length > 0 && (
        <optgroup label="Your voices" className={optionClass}>
          {custom.map(option)}
        </optgroup>
      )}
    </>
  );
}

export default function VoiceSettings() {
  const uid = useId();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const preview = usePreview(audioRef);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const refocusToggle = useRef(false);

  // What the server will use now, and the names of every voice we've seen
  // (so the summary can say "Ara & Helios" instead of showing ids).
  const [settings, setSettings] = useState<Settings | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [names, setNames] = useState<Record<string, string>>({});
  const [flash, setFlash] = useState<string | null>(null);

  // The editing session; closePanel() throws all of it away, including a typed key.
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<Provider>("grok");
  const [apiKey, setApiKey] = useState("");
  const [voices, setVoices] = useState<Voice[] | null>(null);
  const [picks, setPicks] = useState<Partial<Record<Host, string>>>({});
  const [request, setRequest] = useState<VoiceRequest | null>(null); // a voices fetch is in flight while set
  const [busy, setBusy] = useState<"save" | "reset" | null>(null);
  const [problem, setProblem] = useState<{ where: "voices" | "save"; message: string } | null>(null);

  // Load the saved settings once (and again on Retry).
  useEffect(() => {
    const ctrl = new AbortController();
    loadSettings(ctrl.signal).then(
      (next) => {
        if (ctrl.signal.aborted) return;
        setSettings(next);
        setFetchError(null);
      },
      (err) => {
        if (ctrl.signal.aborted) return;
        setFetchError(messageOf(err, "Couldn't load voice settings."));
      }
    );
    return () => ctrl.abort();
  }, [attempt]);

  // Fetch the voice list for the current request. Handlers only set `request`;
  // replacing or clearing it (provider switch, key edit, Cancel) aborts the one in flight.
  useEffect(() => {
    if (!request) return;
    const ctrl = new AbortController();
    fetchVoices(request, ctrl.signal).then(
      (list) => {
        if (ctrl.signal.aborted) return;
        setVoices(list);
        setNames((prev) => {
          const next = { ...prev };
          for (const v of list) next[`${request.provider}:${v.id}`] = v.name;
          return next;
        });
        setRequest(null);
      },
      (err) => {
        if (ctrl.signal.aborted) return;
        setProblem({ where: "voices", message: messageOf(err, "Couldn't load voices.") });
        setRequest(null);
      }
    );
    return () => ctrl.abort();
  }, [request]);

  // The "Saved" confirmation is brief.
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), 4000);
    return () => clearTimeout(timer);
  }, [flash]);

  // After Save / Use instance defaults the focused button disappears; hand focus back to the toggle.
  useEffect(() => {
    if (!open && refocusToggle.current) {
      refocusToggle.current = false;
      toggleRef.current?.focus();
    }
  }, [open]);

  // --- Derived state -------------------------------------------------------

  const s = settings ?? NOT_SET_UP;
  const key = apiKey.trim();
  const label = PROVIDER_LABEL[provider];
  const ownKeyHere = s.ownKey && s.provider === provider; // the user's key is for this vendor
  const usable = keyAvailable(s, provider, key);
  const loading = request !== null;
  const saved = s.provider === provider ? s : null; // voice ids belong to one vendor
  const selection = voices && {
    A: chooseVoice(voices, "A", picks.A, saved?.voiceA),
    B: chooseVoice(voices, "B", picks.B, saved?.voiceB),
  };
  const keyHelp = ownKeyHere
    ? `Using your key${s.keyHint ? ` ••••${s.keyHint}` : ""}`
    : s.instance[provider]
      ? "Optional — leave blank to use this instance's key"
      : `Required — this instance has no ${label} key`;

  // --- Handlers ------------------------------------------------------------

  const requestFor = (p: Provider, typed: string) => (keyAvailable(s, p, typed) ? { provider: p, key: typed } : null);

  /** Whatever was fetched or picked belongs to one provider + key, so it goes when either changes. */
  function clearVoices(next: VoiceRequest | null = null) {
    preview.stop();
    setVoices(null);
    setPicks({});
    setProblem(null);
    setRequest(next);
  }

  function openPanel() {
    const start = effectiveProvider(s);
    setFlash(null);
    setProvider(start);
    setOpen(true);
    setRequest(requestFor(start, "")); // most people never press "Load voices"
  }

  function closePanel() {
    clearVoices();
    setOpen(false);
    setApiKey("");
    setBusy(null);
  }

  function applied(next: Settings, message: string) {
    setSettings(next);
    setFlash(message);
    refocusToggle.current = true;
    closePanel();
  }

  function chooseProvider(next: Provider) {
    if (next === provider) return;
    clearVoices(requestFor(next, ""));
    setProvider(next);
    setApiKey(""); // keys are vendor-specific: never carry one across
  }

  function onKeyChange(value: string) {
    clearVoices();
    setApiKey(value);
  }

  function loadVoices() {
    if (loading || !usable) return;
    setProblem(null);
    setRequest({ provider, key });
  }

  function pick(host: Host, voiceId: string) {
    setPicks((prev) => ({ ...prev, [host]: voiceId }));
    if (preview.state?.host === host) preview.stop(); // the sample (or its error) no longer matches the select
  }

  function togglePreview(host: Host) {
    if (!selection) return;
    const phase = preview.state?.host === host ? preview.state.phase : null;
    if (phase === "loading" || phase === "playing") preview.stop(); // a second click cancels
    else void preview.play(host, { provider, voiceId: selection[host], apiKey: key });
  }

  async function save() {
    if (!selection || busy) return;
    preview.stop();
    setBusy("save");
    setProblem(null);
    // Without a typed key the server keeps the stored one (and drops it if the vendor changed).
    const body = { provider, voiceA: selection.A, voiceB: selection.B, ...(key ? { apiKey: key } : {}) };
    try {
      applied(parseSettings(await requestJson("/api/voice/settings", "PUT", body)), "Saved");
    } catch (err) {
      setProblem({ where: "save", message: messageOf(err, "Couldn't save your voices.") });
      setBusy(null);
    }
  }

  async function resetToInstance() {
    if (busy) return;
    preview.stop();
    setBusy("reset");
    setProblem(null);
    try {
      applied(parseSettings(await requestJson("/api/voice/settings", "DELETE")), "Back to this instance's defaults");
    } catch (err) {
      setProblem({ where: "save", message: messageOf(err, "Couldn't reset your voices.") });
      setBusy(null);
    }
  }

  // --- Render --------------------------------------------------------------

  const keyId = `${uid}-key`;
  const helpId = `${uid}-key-help`;
  const providerLabelId = `${uid}-provider`;
  const tapping = preview.state?.phase === "tap";

  return (
    <section
      aria-label="Podcast voices"
      className="rounded-2xl border border-white/10 bg-white/[0.06] p-5 shadow-lg shadow-black/20 backdrop-blur-xl"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1 break-words text-sm text-zinc-400">
          <h2 className={`font-heading tracking-wide text-zinc-100 ${open ? "text-2xl" : "inline text-lg"}`}>Voices</h2>
          {!open && (
            <span> · {settings ? describe(s, names) : fetchError ? "couldn't load settings" : "loading…"}</span>
          )}
        </div>
        {settings ? (
          <button
            ref={toggleRef}
            type="button"
            onClick={open ? closePanel : openPanel}
            disabled={busy !== null}
            className={`${secondaryButton} shrink-0`}
          >
            {open ? "Cancel" : "Change"}
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
        <div className="mt-4 space-y-5 border-t border-white/10 pt-4">
          {/* Provider */}
          <div className="space-y-2">
            <p id={providerLabelId} className="text-sm text-zinc-400">
              Voice provider
            </p>
            <div role="group" aria-labelledby={providerLabelId} className="flex flex-wrap gap-2">
              {PROVIDERS.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => chooseProvider(id)}
                  aria-pressed={provider === id}
                  className={pillClass(provider === id)}
                >
                  {PROVIDER_LABEL[id]}
                </button>
              ))}
            </div>
          </div>

          {/* API key */}
          <div className="space-y-2">
            <label htmlFor={keyId} className="block text-sm text-zinc-400">
              API key
            </label>
            <input
              id={keyId}
              type="password"
              value={apiKey}
              onChange={(e) => onKeyChange(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && loadVoices()}
              autoComplete="new-password" // "off" is ignored on password fields; this keeps saved logins out
              spellCheck={false}
              data-1p-ignore
              data-lpignore="true"
              placeholder={ownKeyHere ? "Paste a new key to replace it" : `Paste your ${label} API key`}
              aria-describedby={helpId}
              className={`${fieldClass} w-full`}
            />
            <p id={helpId} className="text-xs text-zinc-500">
              {keyHelp}
            </p>
          </div>

          {/* Voice list */}
          <div>
            <button type="button" onClick={loadVoices} disabled={loading || !usable} className={secondaryButton}>
              Load voices
            </button>
            <Live tone={problem?.where === "voices" ? "error" : "info"}>
              {loading ? (
                <span className="inline-flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-sky-400 border-t-transparent motion-reduce:animate-none"
                  />
                  Loading voices…
                </span>
              ) : problem?.where === "voices" ? (
                problem.message
              ) : null}
            </Live>
          </div>

          {/* Host voices */}
          {voices && selection && (
            <div className="space-y-4">
              {HOSTS.map(({ host, label: hostLabel }) => {
                const mine = preview.state?.host === host ? preview.state : null;
                const running = mine?.phase === "loading" || mine?.phase === "playing";
                const note: { tone: Tone; text: string } | null = !mine
                  ? null
                  : mine.phase === "error"
                    ? { tone: "error", text: mine.message }
                    : { tone: "info", text: PREVIEW_NOTE[mine.phase] };
                const selectId = `${uid}-voice-${host}`;
                return (
                  <div key={host}>
                    <label htmlFor={selectId} className="mb-1.5 block text-sm text-zinc-400">
                      {hostLabel}
                    </label>
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        id={selectId}
                        value={selection[host]}
                        onChange={(e) => pick(host, e.target.value)}
                        className={`${fieldClass} min-w-[10rem] flex-1`}
                      >
                        <VoiceOptions voices={voices} />
                      </select>
                      <button
                        type="button"
                        onClick={() => togglePreview(host)}
                        aria-label={running ? `Stop Host ${host} preview` : `Preview Host ${host} voice`}
                        className={`${secondaryButton} inline-flex min-w-28 items-center justify-center gap-1.5`}
                      >
                        <span aria-hidden="true">{running ? "■" : "▶"}</span> {running ? "Stop" : "Preview"}
                      </button>
                    </div>
                    <Live tone={note?.tone}>{note?.text}</Live>
                  </div>
                );
              })}
            </div>
          )}

          {/* The one shared player. Hidden unless the browser blocks autoplay and the person must tap play. */}
          <audio
            ref={audioRef}
            controls={tapping}
            preload="none"
            aria-label="Voice sample"
            onPlaying={preview.onPlaying}
            onEnded={preview.onEnded}
            onError={preview.onError}
            className={tapping ? "w-full" : "hidden"}
          />

          {/* Actions */}
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={save}
                disabled={!selection || loading || busy !== null}
                className={primaryButton}
              >
                {busy === "save" ? "Saving…" : "Save voices"}
              </button>
              {s.source === "user" && (
                <button type="button" onClick={resetToInstance} disabled={busy !== null} className={secondaryButton}>
                  {busy === "reset" ? "Resetting…" : "Use instance defaults"}
                </button>
              )}
            </div>
            <Live tone="error">{problem?.where === "save" ? problem.message : null}</Live>
          </div>
        </div>
      )}
      <Live tone={settings ? "ok" : "error"}>{settings ? flash : fetchError}</Live>
    </section>
  );
}
