import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { JobRef, OpenAIAdapter, OutputFormat, ReasoningEffort, ReasoningMode, ResponseLike } from "./types.js";
import { resolveContext, readStdinIfRequested, stableContextHash } from "./context.js";
import {
  DEFAULT_MODEL,
  DEFAULT_POLL_INTERVAL,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_REASONING_MODE,
  DEFAULT_TIMEOUT
} from "./defaults.js";
import { JobStore, updateJobFromResponse } from "./jobs.js";
import { terminalErrorMessage, extractOutputText, normalizeStatus } from "./output.js";
import { pollResponse } from "./poller.js";
import { prepareConsultationRequest } from "./request.js";
import { formatElapsed, parseDurationMs } from "./time.js";

export interface CommandDeps {
  api: OpenAIAdapter;
  jobStore: JobStore;
  cwd: string;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

export interface AskOptions {
  file?: string[];
  dir?: string[];
  exclude?: string[];
  stdin?: boolean;
  dryRun?: boolean;
  model?: string;
  reasoning?: ReasoningEffort;
  reasoningMode?: ReasoningMode;
  timeout?: string;
  pollInterval?: string;
  format?: OutputFormat;
  output?: string;
  maxOutputTokens?: number;
  cancelOnInterrupt?: boolean;
  registerSignals?: boolean;
}

export type ResumeOptions = Pick<
  AskOptions,
  "timeout" | "pollInterval" | "format" | "output" | "cancelOnInterrupt" | "registerSignals"
>;

interface WaitOptions {
  timeout?: string;
  pollInterval?: string;
  format: OutputFormat;
  outputPath?: string;
  cancelOnInterrupt?: boolean;
  registerSignals?: boolean;
}

export async function runAsk(promptParts: string[], options: AskOptions, deps: CommandDeps): Promise<number> {
  const model = options.model ?? DEFAULT_MODEL;
  const reasoningEffort = options.reasoning ?? DEFAULT_REASONING_EFFORT;
  const reasoningMode = options.reasoningMode ?? DEFAULT_REASONING_MODE;
  const format = options.format ?? "text";
  const prompt = promptParts.join(" ").trim();
  const stdinText = await readStdinIfRequested(Boolean(options.stdin));

  if (!prompt && !stdinText.trim()) {
    throw new Error("Provide a prompt argument or pass --stdin.");
  }

  const context = await resolveContext({
    cwd: deps.cwd,
    files: options.file ?? [],
    dirs: options.dir ?? [],
    excludes: options.exclude ?? []
  });

  if (options.dryRun) {
    if (format === "json") {
      const payload = {
        model,
        reasoning_effort: reasoningEffort,
        reasoning_mode: reasoningMode,
        prompt,
        stdin_bytes: Buffer.byteLength(stdinText),
        context_hash: stableContextHash(context),
        files: context.files.map((file) => ({
          path: file.relativePath,
          bytes: file.bytes,
          mime_type: file.mimeType
        })),
        skipped_files: context.skipped,
        total_bytes: context.totalBytes
      };
      deps.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      deps.stdout.write(`${context.manifest}\n`);
    }
    return 0;
  }

  const prepared = await prepareConsultationRequest(deps.api, {
    model,
    reasoningEffort,
    reasoningMode,
    prompt,
    stdinText,
    context,
    maxOutputTokens: options.maxOutputTokens
  });

  const created = await deps.api.createResponse(prepared.body);
  const outputPath = options.output ? path.resolve(deps.cwd, options.output) : undefined;
  const record = await deps.jobStore.create({
    responseId: created.id,
    model,
    reasoningEffort,
    reasoningMode,
    status: normalizeStatus(created.status),
    prompt: prepared.fullPrompt,
    manifest: context.manifest,
    uploadedFiles: prepared.uploadedFiles,
    skippedFiles: context.skipped,
    outputPath,
    format
  });

  deps.stderr.write(`Started ${record.jobId} (${record.responseId}).\n`);
  return await waitForJob(
    { responseId: record.responseId, record },
    {
      timeout: options.timeout,
      pollInterval: options.pollInterval,
      format,
      outputPath,
      cancelOnInterrupt: options.cancelOnInterrupt,
      registerSignals: options.registerSignals
    },
    deps
  );
}

export async function runResume(id: string, options: ResumeOptions, deps: CommandDeps): Promise<number> {
  const ref = await deps.jobStore.load(id);
  const outputPath = options.output ? path.resolve(deps.cwd, options.output) : ref.record?.outputPath;
  const format = options.format ?? ref.record?.format ?? "text";
  if (ref.record) {
    ref.record = { ...ref.record, outputPath, format };
  }
  return await waitForJob(
    ref,
    {
      timeout: options.timeout,
      pollInterval: options.pollInterval,
      format,
      outputPath,
      cancelOnInterrupt: options.cancelOnInterrupt,
      registerSignals: options.registerSignals
    },
    deps
  );
}

export async function runStatus(id: string, options: { format?: OutputFormat }, deps: CommandDeps): Promise<number> {
  return await runResponseAction(id, options, deps, (api, responseId) => api.retrieveResponse(responseId));
}

export async function runCancel(id: string, options: { format?: OutputFormat }, deps: CommandDeps): Promise<number> {
  return await runResponseAction(id, options, deps, (api, responseId) => api.cancelResponse(responseId));
}

async function runResponseAction(
  id: string,
  options: { format?: OutputFormat },
  deps: CommandDeps,
  action: (api: OpenAIAdapter, responseId: string) => Promise<ResponseLike>
): Promise<number> {
  const ref = await deps.jobStore.load(id);
  const response = await action(deps.api, ref.responseId);
  await saveUpdatedRecord(ref, response, deps.jobStore);

  const payload = responsePayload(ref, response);
  if ((options.format ?? "text") === "json") {
    deps.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    deps.stdout.write(`${displayId(ref)}: ${payload.status} (${ref.responseId})\n`);
    if (payload.error) deps.stdout.write(`${payload.error}\n`);
  }
  return 0;
}

async function waitForJob(ref: JobRef, options: WaitOptions, deps: CommandDeps): Promise<number> {
  const timeoutMs = parseDurationMs(options.timeout ?? DEFAULT_TIMEOUT);
  const pollIntervalMs = parseDurationMs(options.pollInterval ?? DEFAULT_POLL_INTERVAL);
  const startedAt = Date.now();
  let interrupted = false;

  const onInterrupt = () => {
    interrupted = true;
  };

  if (options.registerSignals !== false) {
    process.once("SIGINT", onInterrupt);
  }

  try {
    const outcome = await pollResponse(deps.api, ref.responseId, {
      timeoutMs,
      pollIntervalMs,
      shouldStop: () => interrupted,
      onPoll: async (response) => {
        await saveUpdatedRecord(ref, response, deps.jobStore);
        deps.stderr.write(`Status ${normalizeStatus(response.status)} after ${formatElapsed(Date.now() - startedAt)}.\n`);
      }
    });

    switch (outcome.kind) {
      case "stopped": {
        if (options.cancelOnInterrupt) {
          const cancelled = await deps.api.cancelResponse(ref.responseId);
          await saveUpdatedRecord(ref, cancelled, deps.jobStore);
          deps.stderr.write(`Cancelled ${displayId(ref)} (${ref.responseId}).\n`);
        } else {
          if (ref.record) {
            await deps.jobStore.save({ ...ref.record, status: "interrupted" });
          }
          deps.stderr.write(`Interrupted. Response is still running; resume with: expert resume ${displayId(ref)}\n`);
        }
        return 130;
      }
      case "timeout": {
        if (outcome.response) {
          await saveUpdatedRecord(ref, outcome.response, deps.jobStore);
        }
        deps.stderr.write(`Timed out after ${formatElapsed(timeoutMs)}. Resume with: expert resume ${displayId(ref)}\n`);
        return 124;
      }
      default: {
        await saveUpdatedRecord(ref, outcome.response, deps.jobStore);
        if (normalizeStatus(outcome.response.status) !== "completed") {
          deps.stderr.write(`${terminalErrorMessage(outcome.response)}\n`);
          return 1;
        }
        await writeFinalResponse(outcome.response, ref, options, deps);
        return 0;
      }
    }
  } catch (error) {
    if (ref.record) {
      await deps.jobStore.save({
        ...ref.record,
        status: "error",
        lastError: error instanceof Error ? error.message : String(error)
      });
    }
    throw error;
  } finally {
    if (options.registerSignals !== false) {
      process.removeListener("SIGINT", onInterrupt);
    }
  }
}

async function writeFinalResponse(response: ResponseLike, ref: JobRef, options: WaitOptions, deps: CommandDeps): Promise<void> {
  const text = extractOutputText(response);
  const payload = responsePayload(ref, response, text);
  const rendered = options.format === "json" ? `${JSON.stringify(payload, null, 2)}\n` : `${text}\n`;

  if (options.outputPath) {
    await writeFile(options.outputPath, rendered, "utf8");
  }
  deps.stdout.write(rendered);
}

function responsePayload(ref: JobRef, response: ResponseLike, outputText = extractOutputText(response)) {
  return {
    job_id: displayId(ref),
    response_id: ref.responseId,
    model: ref.record?.model ?? "unknown",
    reasoning_effort: ref.record?.reasoningEffort ?? null,
    reasoning_mode: ref.record?.reasoningMode ?? null,
    status: normalizeStatus(response.status),
    output_text: outputText,
    error: response.error?.message ?? null,
    incomplete_reason: response.incomplete_details?.reason ?? null,
    usage: response.usage ?? null,
    uploaded_files: ref.record?.uploadedFiles ?? [],
    skipped_files: ref.record?.skippedFiles ?? []
  };
}

function displayId(ref: JobRef): string {
  return ref.record?.jobId ?? ref.responseId;
}

async function saveUpdatedRecord(ref: JobRef, response: ResponseLike, jobStore: JobStore): Promise<void> {
  if (!ref.record) return;
  ref.record = updateJobFromResponse(ref.record, response);
  await jobStore.save(ref.record);
}
