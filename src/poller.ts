import type { OpenAIAdapter, ResponseLike } from "./types.js";
import { isActiveStatus } from "./output.js";
import { sleep } from "./time.js";

export interface PollOptions {
  timeoutMs: number;
  pollIntervalMs: number;
  onPoll?: (response: ResponseLike) => Promise<void> | void;
  shouldStop?: () => boolean;
}

export type PollOutcome =
  | { kind: "terminal"; response: ResponseLike }
  | { kind: "stopped"; response: ResponseLike | null }
  | { kind: "timeout"; response: ResponseLike | null };

export async function pollResponse(
  api: OpenAIAdapter,
  responseId: string,
  options: PollOptions
): Promise<PollOutcome> {
  const deadline = Date.now() + options.timeoutMs;
  let attempt = 0;
  let lastResponse: ResponseLike | null = null;

  while (Date.now() < deadline) {
    if (options.shouldStop?.()) {
      return { kind: "stopped", response: lastResponse };
    }

    try {
      const response = await api.retrieveResponse(responseId);
      attempt = 0;
      lastResponse = response;
      await options.onPoll?.(response);
      if (!isActiveStatus(response.status)) {
        return { kind: "terminal", response };
      }
      await interruptibleSleep(cappedDelay(options.pollIntervalMs, deadline), options.shouldStop);
    } catch (error) {
      if (!isRetryableError(error)) throw error;
      const delayMs = retryDelayMs(error, attempt++, options.pollIntervalMs);
      await interruptibleSleep(cappedDelay(delayMs, deadline), options.shouldStop);
    }
  }

  return { kind: "timeout", response: lastResponse };
}

// The timeout is a hard deadline: never sleep past it, even when the server
// requests a longer Retry-After.
function cappedDelay(delayMs: number, deadline: number): number {
  return Math.max(0, Math.min(delayMs, deadline - Date.now()));
}

// Sleep in short slices so Ctrl-C is honored mid-interval instead of after a
// full poll or retry delay.
async function interruptibleSleep(ms: number, shouldStop?: () => boolean): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (shouldStop?.()) return;
    await sleep(Math.min(250, end - Date.now()));
  }
}

function isRetryableError(error: unknown): boolean {
  const status = httpStatus(error);
  if (status === 429) return true;
  if (status !== undefined && status >= 500) return true;
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ECONNRESET" || code === "ETIMEDOUT" || code === "EAI_AGAIN";
  }
  return false;
}

function retryDelayMs(error: unknown, attempt: number, pollIntervalMs: number): number {
  const retryAfter = retryAfterMs(error);
  if (retryAfter !== null) return retryAfter;
  const base = Math.min(pollIntervalMs, 5_000);
  const exponential = base * 2 ** Math.min(attempt, 5);
  return Math.min(exponential, 30_000);
}

function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { status?: unknown; code?: unknown };
  if (typeof candidate.status === "number") return candidate.status;
  if (typeof candidate.code === "number") return candidate.code;
  return undefined;
}

function retryAfterMs(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const headers = (error as { headers?: unknown }).headers;
  const value = getHeader(headers, "retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

function getHeader(headers: unknown, key: string): string | null {
  if (!headers) return null;
  if (typeof (headers as { get?: unknown }).get === "function") {
    const value = (headers as { get: (name: string) => string | null }).get(key);
    return value;
  }
  if (typeof headers === "object") {
    const record = headers as Record<string, unknown>;
    const value = record[key] ?? record[key.toLowerCase()] ?? record[key.toUpperCase()];
    return typeof value === "string" ? value : null;
  }
  return null;
}
