import path from "node:path";
import type { ResponseCreateParamsNonStreaming, ResponseInputContent } from "openai/resources/responses/responses";
import type { ContextBundle, OpenAIAdapter, ReasoningEffort, ReasoningMode, UploadedFile } from "./types.js";

export interface ConsultationRequestOptions {
  model: string;
  reasoningEffort: ReasoningEffort;
  reasoningMode: ReasoningMode;
  prompt: string;
  stdinText?: string;
  context: ContextBundle;
  maxOutputTokens?: number;
}

export interface PreparedConsultationRequest {
  body: ResponseCreateParamsNonStreaming;
  uploadedFiles: UploadedFile[];
  fullPrompt: string;
}

const UPLOAD_CONCURRENCY = 8;

export async function prepareConsultationRequest(
  api: OpenAIAdapter,
  options: ConsultationRequestOptions
): Promise<PreparedConsultationRequest> {
  const uploadedFiles = await mapWithConcurrency(options.context.files, UPLOAD_CONCURRENCY, (file) =>
    api.uploadFile(file.absolutePath)
  );

  const fullPrompt = buildFullPrompt(options.prompt, options.stdinText ?? "", options.context.manifest);
  const content: ResponseInputContent[] = [
    ...uploadedFiles.map(
      (file): ResponseInputContent => ({
        type: "input_file",
        file_id: file.id,
        filename: path.basename(file.filename)
      })
    ),
    {
      type: "input_text",
      text: fullPrompt
    }
  ];

  // "standard" is expressed by omitting mode: pre-GPT-5.6 models reject the parameter.
  const reasoning: ResponseCreateParamsNonStreaming["reasoning"] =
    options.reasoningMode === "pro"
      ? { effort: options.reasoningEffort, mode: "pro" }
      : { effort: options.reasoningEffort };

  const body: ResponseCreateParamsNonStreaming = {
    model: options.model,
    background: true,
    store: true,
    reasoning,
    input: [
      {
        role: "user",
        content
      }
    ]
  };

  if (options.maxOutputTokens !== undefined) {
    body.max_output_tokens = options.maxOutputTokens;
  }

  return { body, uploadedFiles, fullPrompt };
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function buildFullPrompt(prompt: string, stdinText: string, manifest: string): string {
  const sections = [
    "You are being consulted by another agent. Answer directly, use the attached context where relevant, and call out uncertainty or missing information.",
    "",
    "User request:",
    prompt.trim() || "(No explicit prompt provided.)"
  ];

  if (stdinText.trim()) {
    sections.push("", "Additional stdin context:", stdinText.trim());
  }

  sections.push("", manifest);
  return sections.join("\n");
}
