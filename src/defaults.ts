import type { ReasoningEffort, ReasoningMode } from "./types.js";

export const DEFAULT_MODEL = "gpt-5.6";
export const DEFAULT_MODEL_DISPLAY_NAME = "GPT-5.6 Pro";
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "xhigh";
export const DEFAULT_TIMEOUT = "60m";
export const DEFAULT_POLL_INTERVAL = "5s";

// Pre-GPT-5.6 models reject reasoning.mode, so "pro" is only a safe default
// for models known to support it.
export function defaultReasoningMode(model: string): ReasoningMode {
  return model.startsWith("gpt-5.6") ? "pro" : "standard";
}
