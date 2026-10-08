import "server-only";
import OpenAI from "openai";
import { env } from "./env";

// Two-tier model strategy for token efficiency:
//  FAST  — high-volume per-post work (categorize, describe images, staleness)
//  SMART — synthesis where reasoning quality shows (outline, digest, script)
//
// Picked 2026-10-05 from the account's catalog (GET /v1/language-models):
//  grok-4.3  $1.25/M in, $2.50/M out — same price as the old 4.20 non-reasoning
//            model, newer, 1M context. Reasoning "none" keeps per-post calls cheap.
//  grok-4.7  $2.00/M in, $6.00/M out — same price as grok-4.5, current flagship.
//            Reasoning tokens bill as output, so effort defaults to "medium".
export const FAST_MODEL = process.env.XAI_MODEL_FAST ?? "grok-4.3";
export const SMART_MODEL = process.env.XAI_MODEL_SMART ?? "grok-4.7";
// Reasoning effort per tier (none | low | medium | high | xhigh). Set the env var
// to an empty string to omit the parameter, e.g. for a model that rejects it.
export const FAST_REASONING = process.env.XAI_REASONING_FAST ?? "none";
export const SMART_REASONING = process.env.XAI_REASONING_SMART ?? "medium";

function reasoningFor(model: string): Record<string, string> {
  const effort = model === SMART_MODEL ? SMART_REASONING : model === FAST_MODEL ? FAST_REASONING : "";
  return effort ? { reasoning_effort: effort } : {};
}

let client: OpenAI | null = null;
function grok(): OpenAI {
  if (!client) {
    client = new OpenAI({ apiKey: env("XAI_API_KEY"), baseURL: "https://api.x.ai/v1" });
  }
  return client;
}

type ContentParts = string | Array<Record<string, unknown>>;

export async function grokText(
  model: string,
  system: string,
  user: ContentParts,
  options: { temperature?: number; extraBody?: Record<string, unknown> } = {}
): Promise<string> {
  const res = await grok().chat.completions.create({
    model,
    messages: [
      { role: "system", content: system },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { role: "user", content: user as any },
    ],
    temperature: options.temperature ?? 0.4,
    ...reasoningFor(model),
    ...(options.extraBody ?? {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  return res.choices[0]?.message?.content ?? "";
}

/**
 * Query with xAI's server-side X/web search (Agent Tools API via /v1/responses).
 * Returns the model's final text after it has searched.
 */
export async function grokSearchText(system: string, user: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = await (grok() as any).responses.create({
    model: SMART_MODEL,
    input: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    tools: [{ type: "x_search" }, { type: "web_search" }],
    ...(SMART_REASONING ? { reasoning: { effort: SMART_REASONING } } : {}),
  });
  if (typeof res.output_text === "string" && res.output_text) return res.output_text;
  const texts: string[] = [];
  for (const item of res.output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.type === "output_text" && part.text) texts.push(part.text);
    }
  }
  return texts.join(" ");
}

export async function grokJson<T>(
  model: string,
  system: string,
  user: string,
  extraBody?: Record<string, unknown>
): Promise<T> {
  const res = await grok().chat.completions.create({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
    temperature: 0.2,
    ...reasoningFor(model),
    ...(extraBody ?? {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  return JSON.parse(res.choices[0]?.message?.content ?? "{}") as T;
}
