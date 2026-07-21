import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";

export const REASONING_EFFORTS = ["medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const REASONING_MODES = ["standard", "pro"] as const;
export type ReasoningMode = (typeof REASONING_MODES)[number];

export type OutputFormat = "text" | "json";

export const RESPONSE_STATUSES = [
  "queued",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
  "incomplete"
] as const;
export type ResponseStatus = (typeof RESPONSE_STATUSES)[number];

export const JOB_STATUSES = [...RESPONSE_STATUSES, "interrupted", "error", "unknown"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface ResponseLike {
  id: string;
  status?: ResponseStatus | string | null;
  output_text?: string | null;
  output?: unknown;
  error?: { code?: string | null; message?: string | null } | null;
  incomplete_details?: { reason?: string | null } | null;
  usage?: unknown;
}

export interface UploadedFile {
  id: string;
  filename: string;
  bytes: number;
}

export interface OpenAIAdapter {
  uploadFile(path: string): Promise<UploadedFile>;
  createResponse(body: ResponseCreateParamsNonStreaming): Promise<ResponseLike>;
  retrieveResponse(id: string): Promise<ResponseLike>;
  cancelResponse(id: string): Promise<ResponseLike>;
}

export interface ContextFile {
  absolutePath: string;
  relativePath: string;
  bytes: number;
  mimeType: string;
}

export interface SkippedContextFile {
  path: string;
  reason: string;
}

export interface ContextBundle {
  files: ContextFile[];
  skipped: SkippedContextFile[];
  manifest: string;
  totalBytes: number;
}

export interface JobRecord {
  jobId: string;
  responseId: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  reasoningMode?: ReasoningMode;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  prompt: string;
  manifest: string;
  uploadedFiles: UploadedFile[];
  skippedFiles: SkippedContextFile[];
  outputPath?: string;
  format: OutputFormat;
  lastError?: string;
}

export interface JobRef {
  responseId: string;
  record?: JobRecord;
}
