import type { ReasoningEffort, ReasoningMode } from "./types.js";

export const DEFAULT_MODEL = "gpt-5.6";
export const DEFAULT_MODEL_DISPLAY_NAME = "GPT-5.6 Pro";
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "xhigh";
export const DEFAULT_TIMEOUT = "60m";
export const DEFAULT_POLL_INTERVAL = "5s";

// GPT-5.6 (and GPT-5.5 Pro) have a 1,050,000-token context window shared by
// input, reasoning, and output (128,000 max output tokens). Cap estimated
// input below the window minus the output reserve.
export const MODEL_CONTEXT_WINDOW_TOKENS = 1_050_000;
export const DEFAULT_MAX_CONTEXT_TOKENS = 900_000;
// OpenAI bills requests whose input exceeds this at 2x input / 1.5x output
// for the entire request.
export const PRICING_SURCHARGE_INPUT_TOKENS = 272_000;

// Pre-GPT-5.6 models reject reasoning.mode, so "pro" is only a safe default
// for models known to support it.
export function defaultReasoningMode(model: string): ReasoningMode {
  return model.startsWith("gpt-5.6") ? "pro" : "standard";
}
