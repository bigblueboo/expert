import { readFile } from "node:fs/promises";
import { mapWithConcurrency } from "./concurrency.js";
import { z } from "zod";
import { buildFullPrompt, type ConsultationRequestOptions } from "./request.js";
import type { ReasoningEffort, ResponseLike } from "./types.js";

// Gemini's Interactions API over plain REST: create with background: true, then
// poll GET /interactions/{id} until it leaves in_progress. Docs:
// https://aistudio.google.com/api-reference/interactions-api (checked 2026-11-12).
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
// The docs' REST examples pin this revision; pinning keeps the response shape stable.
const API_REVISION = "2026-05-20";
// File count is not bounded by the byte caps, so cap open files instead.
const READ_CONCURRENCY = 16;

// Google's REST layer may send null for unset fields and numeric error codes,
// so every optional field accepts null and codes may be numbers.
const interactionSchema = z.object({
  id: z.string(),
  status: z.string().nullish(),
  steps: z
    .array(
      z.object({
        type: z.string(),
        content: z.array(z.object({ type: z.string(), text: z.string().nullish() })).nullish()
      })
    )
    .nullish(),
  errors: z
    .array(z.object({ code: z.union([z.string(), z.number()]).nullish(), message: z.string().nullish() }))
    .nullish(),
  usage: z.unknown().optional()
});
type Interaction = z.infer<typeof interactionSchema>;

type ThinkingLevel = "low" | "medium" | "high" | "xhigh";

export interface GeminiCreateBody {
  model: string;
  input: { type: "text"; text: string }[];
  background: true;
  store: true;
  generation_config: { thinking_level: ThinkingLevel; max_output_tokens?: number };
}

export class GeminiHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly headers: Headers
  ) {
    super(message);
  }
}

// The connection failed before a complete HTTP response arrived: a reset, a
// timeout, a socket dropped mid-body. The job keeps running server-side, so
// polling retries these.
export class GeminiTransportError extends Error {
  readonly retryable = true;
}

// Statuses the Responses API also uses pass through; the rest end the job with
// their own name as the reason, since a background interaction has no client
// side to act on them.
const PASSTHROUGH_STATUSES = new Set(["queued", "in_progress", "completed", "failed", "cancelled", "incomplete"]);

export function toResponseLike(interaction: Interaction): ResponseLike {
  const raw = interaction.status ?? "unknown";
  const passthrough = PASSTHROUGH_STATUSES.has(raw);
  const errorText = (interaction.errors ?? [])
    .map((error) => [error.code, error.message].filter((part) => part != null && part !== "").join(": "))
    .filter(Boolean)
    .join("; ");
  const outputText = (interaction.steps ?? [])
    .filter((step) => step.type === "model_output")
    .map((step) => (step.content ?? []).map((part) => (part.type === "text" ? part.text ?? "" : "")).join(""))
    .filter(Boolean)
    .join("\n")
    .trim();
  return {
    id: interaction.id,
    status: passthrough ? raw : "incomplete",
    output_text: outputText,
    error: errorText ? { message: errorText } : null,
    incomplete_details: passthrough ? null : { reason: raw },
    usage: interaction.usage ?? null
  };
}

// geminiBackend.resolveSettings has already refused max; this only narrows the type.
function thinkingLevelFor(effort: ReasoningEffort): ThinkingLevel {
  if (effort === "max") throw new Error("Gemini has no max thinking level.");
  return effort;
}

// Gemini takes the context files inline, one text part each, ahead of the prompt.
// geminiBackend resolves context text-only, so no document formats reach here.
export async function buildGeminiRequest(
  options: ConsultationRequestOptions
): Promise<{ body: GeminiCreateBody; fullPrompt: string }> {
  const fileParts = await mapWithConcurrency(options.context.files, READ_CONCURRENCY, async (file) => ({
    type: "text" as const,
    text: `<file path=${JSON.stringify(file.relativePath)}>\n${await readFile(file.absolutePath, "utf8")}\n</file>`
  }));
  const attachmentNote =
    fileParts.length > 0 ? "The attached files appear above this request, each wrapped in <file path=...> tags." : "";
  const fullPrompt = buildFullPrompt(options.prompt, options.stdinText ?? "", options.context.manifest, attachmentNote);
  const body: GeminiCreateBody = {
    model: options.model,
    input: [...fileParts, { type: "text", text: fullPrompt }],
    background: true,
    store: true,
    generation_config: { thinking_level: thinkingLevelFor(options.reasoningEffort) }
  };
  if (options.maxOutputTokens !== undefined) {
    body.generation_config.max_output_tokens = options.maxOutputTokens;
  }
  return { body, fullPrompt };
}

export interface GeminiAdapter {
  createInteraction(body: GeminiCreateBody): Promise<ResponseLike>;
  retrieveResponse(id: string): Promise<ResponseLike>;
  cancelResponse(id: string): Promise<ResponseLike>;
}

export class GeminiRestAdapter implements GeminiAdapter {
  private readonly apiKey: string | undefined;
  private readonly baseURL: string;

  // Empty values fall back like unset ones, and a key pasted with a trailing
  // newline still works.
  constructor(apiKey = process.env.EXPERT_GEMINI_API_KEY, baseURL = process.env.EXPERT_GEMINI_BASE_URL) {
    this.apiKey = apiKey?.trim() || undefined;
    this.baseURL = baseURL?.trim() || DEFAULT_BASE_URL;
  }

  async createInteraction(body: GeminiCreateBody): Promise<ResponseLike> {
    return await this.call("POST", "/interactions", body);
  }

  async retrieveResponse(id: string): Promise<ResponseLike> {
    return await this.call("GET", `/interactions/${encodeURIComponent(id)}`);
  }

  async cancelResponse(id: string): Promise<ResponseLike> {
    return await this.call("POST", `/interactions/${encodeURIComponent(id)}/cancel`);
  }

  private async call(method: "GET" | "POST", route: string, body?: GeminiCreateBody): Promise<ResponseLike> {
    if (!this.apiKey) {
      throw new Error("EXPERT_GEMINI_API_KEY is required for Gemini models.");
    }
    // Built outside the try: a malformed base URL or key is a configuration
    // error, and retrying it would only stall a poll until its deadline.
    const request = new Request(`${this.baseURL.replace(/\/+$/, "")}${route}`, {
      method,
      headers: {
        "x-goog-api-key": this.apiKey,
        "Api-Revision": API_REVISION,
        ...(body ? { "content-type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    let response: Response;
    let text: string;
    try {
      response = await fetch(request);
      text = await response.text();
    } catch (error) {
      throw new GeminiTransportError(`Gemini API ${method} ${route} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (!response.ok) {
      throw new GeminiHttpError(`Gemini API ${method} ${route} failed with ${response.status}: ${text.slice(0, 2000)}`, response.status, response.headers);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Gemini API ${method} ${route} returned ${response.status} with a non-JSON body: ${text.slice(0, 500)}`);
    }
    return toResponseLike(interactionSchema.parse(json));
  }
}
