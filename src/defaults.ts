import type { ReasoningEffort, ReasoningMode } from "./types.js";

export const DEFAULT_MODEL = "gpt-6-astra";
export const DEFAULT_MODEL_DISPLAY_NAME = "GPT-6 Astra in Pro mode";
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "xhigh";
// GPT Pro consults routinely run for hours; the timeout only bounds local
// polling (the server-side job keeps running), so default generously.
export const DEFAULT_TIMEOUT = "360m";
export const DEFAULT_POLL_INTERVAL = "5s";

// GPT-6 Astra has a 1,050,000-token context window shared by
// input, reasoning, and output (128,000 max output tokens). Cap estimated
// input below the window minus the output reserve.
export const MODEL_CONTEXT_WINDOW_TOKENS = 1_050_000;
export const DEFAULT_MAX_CONTEXT_TOKENS = 900_000;
// OpenAI bills requests whose input exceeds this at 2x input / 1.5x output
// for the entire request.
export const PRICING_SURCHARGE_INPUT_TOKENS = 272_000;

// Default to Pro only for model families documented to support reasoning.mode.
// Older models reject the parameter; their standard requests omit it.
export function defaultReasoningMode(model: string): ReasoningMode {
  return model === "gpt-6-astra" || model.startsWith("gpt-6-astra-") || model.startsWith("gpt-5.6")
    ? "pro"
    : "standard";
}
