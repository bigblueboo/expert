import { RESPONSE_STATUSES } from "./types.js";
import type { JobStatus, ResponseLike, ResponseStatus } from "./types.js";

const ACTIVE_STATUSES = new Set(["queued", "in_progress"]);

const KNOWN_RESPONSE_STATUSES: ReadonlySet<string> = new Set(RESPONSE_STATUSES);

export function isActiveStatus(status: string | null | undefined): boolean {
  return ACTIVE_STATUSES.has(status ?? "");
}

export function normalizeStatus(status: string | null | undefined): JobStatus {
  return status && KNOWN_RESPONSE_STATUSES.has(status) ? (status as ResponseStatus) : "unknown";
}

export function extractOutputText(response: ResponseLike): string {
  if (typeof response.output_text === "string") {
    return response.output_text;
  }

  const parts: string[] = [];
  if (Array.isArray(response.output)) {
    for (const item of response.output) {
      if (!item || typeof item !== "object") continue;
      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const contentPart of content) {
        if (!contentPart || typeof contentPart !== "object") continue;
        const text = (contentPart as { text?: unknown }).text;
        if (typeof text === "string") parts.push(text);
      }
    }
  }

  return parts.join("\n").trim();
}

export function terminalErrorMessage(response: ResponseLike): string {
  const status = normalizeStatus(response.status);
  if (response.error?.message) {
    return `${status}: ${response.error.message}`;
  }
  if (response.incomplete_details?.reason) {
    return `${status}: ${response.incomplete_details.reason}`;
  }
  return `Response ended with status ${status}`;
}
