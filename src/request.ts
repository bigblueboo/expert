import path from "node:path";
import type { ContextBundle, OpenAIAdapter, ReasoningEffort, UploadedFile } from "./types.js";

export interface ConsultationRequestOptions {
  model: string;
  reasoningEffort: ReasoningEffort;
  prompt: string;
  stdinText?: string;
  context: ContextBundle;
  maxOutputTokens?: number;
  fileExpirationSeconds?: number;
}

export interface PreparedConsultationRequest {
  body: Record<string, unknown>;
  uploadedFiles: UploadedFile[];
  fullPrompt: string;
}

export async function prepareConsultationRequest(
  api: OpenAIAdapter,
  options: ConsultationRequestOptions
): Promise<PreparedConsultationRequest> {
  const uploadedFiles: UploadedFile[] = [];
  for (const file of options.context.files) {
    uploadedFiles.push(await api.uploadFile(file.absolutePath, options.fileExpirationSeconds));
  }

  const fullPrompt = buildFullPrompt(options.prompt, options.stdinText ?? "", options.context.manifest);
  const content: Array<Record<string, unknown>> = [
    ...uploadedFiles.map((file) => ({
      type: "input_file",
      file_id: file.id,
      filename: path.basename(file.filename)
    })),
    {
      type: "input_text",
      text: fullPrompt
    }
  ];

  const body: Record<string, unknown> = {
    model: options.model,
    background: true,
    store: true,
    reasoning: { effort: options.reasoningEffort },
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

export function buildFullPrompt(prompt: string, stdinText: string, manifest: string): string {
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
