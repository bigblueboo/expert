import {
  DEFAULT_REASONING_EFFORT,
  GEMINI_CONTEXT_WINDOW_TOKENS,
  MODEL_CONTEXT_WINDOW_TOKENS,
  PRICING_SURCHARGE_INPUT_TOKENS,
  defaultReasoningMode
} from "./defaults.js";
import { buildGeminiRequest, GeminiRestAdapter, type GeminiAdapter } from "./gemini-adapter.js";
import { OpenAISdkAdapter } from "./openai-adapter.js";
import { prepareConsultationRequest, type ConsultationRequestOptions } from "./request.js";
import type { OpenAIAdapter, Provider, ReasoningEffort, ReasoningMode, ResponseLike, ResponseSource, UploadedFile } from "./types.js";

export interface ReasoningSettings {
  reasoningEffort: ReasoningEffort;
  reasoningMode: ReasoningMode;
}

export interface StartedConsultation extends ResponseLike {
  fullPrompt: string;
  uploadedFiles: UploadedFile[];
}

// Everything that differs between providers. The commands pick one backend per
// job (by model when starting, by JobRef.provider afterwards) and never branch
// on the provider themselves.
export interface Backend extends ResponseSource {
  readonly contextWindowTokens: number;
  // Resolve context to text files only, for providers that take files inline.
  readonly textOnlyContext: boolean;
  // Fill in defaults and reject combinations the provider cannot serve.
  resolveSettings(model: string, effort?: ReasoningEffort, mode?: ReasoningMode): ReasoningSettings;
  costWarning(estimatedInputTokens: number): string | null;
  start(options: ConsultationRequestOptions): Promise<StartedConsultation>;
}

export type Backends = Record<Provider, Backend>;

// Gemini 4 Carbon and Argon top out at high thinking; Hydrogen adds xhigh.
const HIGH_THINKING_CAP = /^gemini-4-(carbon|argon)(-|$)/;

export function providerFor(model: string): Provider {
  return model.startsWith("gemini-") ? "gemini" : "openai";
}

export function openAIBackend(api: OpenAIAdapter): Backend {
  return {
    contextWindowTokens: MODEL_CONTEXT_WINDOW_TOKENS,
    textOnlyContext: false,
    resolveSettings: (model, effort, mode) => ({
      reasoningEffort: effort ?? DEFAULT_REASONING_EFFORT,
      reasoningMode: mode ?? defaultReasoningMode(model)
    }),
    costWarning: (tokens) =>
      tokens > PRICING_SURCHARGE_INPUT_TOKENS
        ? `estimated input (~${tokens.toLocaleString("en-US")} tokens) exceeds ` +
          `${PRICING_SURCHARGE_INPUT_TOKENS.toLocaleString("en-US")}; OpenAI bills such requests at 2x input / 1.5x output ` +
          `for the entire request.`
        : null,
    async start(options) {
      const prepared = await prepareConsultationRequest(api, options);
      const created = await api.createResponse(prepared.body);
      return { ...created, fullPrompt: prepared.fullPrompt, uploadedFiles: prepared.uploadedFiles };
    },
    retrieveResponse: (id) => api.retrieveResponse(id),
    cancelResponse: (id) => api.cancelResponse(id)
  };
}

export function geminiBackend(adapter: GeminiAdapter): Backend {
  return {
    contextWindowTokens: GEMINI_CONTEXT_WINDOW_TOKENS,
    textOnlyContext: true,
    resolveSettings: (model, effort, mode) => {
      if (mode === "pro") {
        throw new Error("Pro reasoning mode is OpenAI-only; Gemini models run with --reasoning-mode standard.");
      }
      if (effort === "max") {
        throw new Error("Gemini has no max thinking level; use --reasoning high (or xhigh on models that support it).");
      }
      if (effort === "xhigh" && HIGH_THINKING_CAP.test(model)) {
        throw new Error(`${model} tops out at high thinking; use --reasoning high.`);
      }
      return { reasoningEffort: effort ?? "high", reasoningMode: "standard" };
    },
    costWarning: () => null,
    async start(options) {
      const { body, fullPrompt } = await buildGeminiRequest(options);
      return { ...(await adapter.createInteraction(body)), fullPrompt, uploadedFiles: [] };
    },
    retrieveResponse: (id) => adapter.retrieveResponse(id),
    cancelResponse: (id) => adapter.cancelResponse(id)
  };
}

// Real adapters by default; each reads its own key only when first called.
export function createBackends(adapters: { openai?: OpenAIAdapter; gemini?: GeminiAdapter } = {}): Backends {
  return {
    openai: openAIBackend(adapters.openai ?? new OpenAISdkAdapter()),
    gemini: geminiBackend(adapters.gemini ?? new GeminiRestAdapter())
  };
}
