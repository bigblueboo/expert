export type ReasoningEffort = "medium" | "high" | "xhigh";
export type OutputFormat = "text" | "json";

export type ResponseStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "incomplete";

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
  uploadFile(path: string, expiresAfterSeconds?: number): Promise<UploadedFile>;
  createResponse(body: Record<string, unknown>): Promise<ResponseLike>;
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
  status: string;
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
