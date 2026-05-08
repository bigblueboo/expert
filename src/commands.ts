import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ContextBundle, JobRecord, OpenAIAdapter, OutputFormat, ReasoningEffort, ResponseLike } from "./types.js";
import { resolveContext, readStdinIfRequested, stableContextHash } from "./context.js";
import { DEFAULT_MODEL } from "./defaults.js";
import { JobStore } from "./jobs.js";
import { terminalErrorMessage, extractOutputText, normalizeStatus } from "./output.js";
import { pollResponse, PollTimeoutError, updateJobFromResponse } from "./poller.js";
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
  include?: string[];
  exclude?: string[];
  stdin?: boolean;
  dryRun?: boolean;
  model?: string;
  reasoning?: ReasoningEffort;
  timeout?: string;
  pollInterval?: string;
  format?: OutputFormat;
  output?: string;
  maxOutputTokens?: number;
  cancelOnInterrupt?: boolean;
  fileExpirationSeconds?: number;
  registerSignals?: boolean;
}

export async function runAsk(promptParts: string[], options: AskOptions, deps: CommandDeps): Promise<number> {
  const model = options.model ?? DEFAULT_MODEL;
  const reasoningEffort = options.reasoning ?? "xhigh";
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
    includes: options.include ?? [],
    excludes: options.exclude ?? []
  });

  if (options.dryRun) {
    writePayload(
      deps.stdout,
      format,
      {
        model,
        reasoning_effort: reasoningEffort,
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
      },
      context.manifest
    );
    return 0;
  }

  const prepared = await prepareConsultationRequest(deps.api, {
    model,
    reasoningEffort,
    prompt,
    stdinText,
    context,
    maxOutputTokens: options.maxOutputTokens,
    fileExpirationSeconds: options.fileExpirationSeconds
  });

  const created = await deps.api.createResponse(prepared.body);
  const job = await deps.jobStore.create({
    responseId: created.id,
    model,
    reasoningEffort,
    status: normalizeStatus(created.status),
    prompt: prepared.fullPrompt,
    manifest: context.manifest,
    uploadedFiles: prepared.uploadedFiles,
    skippedFiles: context.skipped,
    outputPath: options.output ? path.resolve(deps.cwd, options.output) : undefined,
    format
  });

  deps.stderr.write(`Started ${job.jobId} (${job.responseId}).\n`);
  return await waitForJob(job, options, deps, context);
}

export async function runResume(id: string, options: Pick<AskOptions, "timeout" | "pollInterval" | "format" | "output" | "cancelOnInterrupt" | "registerSignals">, deps: CommandDeps): Promise<number> {
  const job = await deps.jobStore.load(id);
  const outputPath = options.output ? path.resolve(deps.cwd, options.output) : job.outputPath;
  return await waitForJob({ ...job, outputPath, format: options.format ?? job.format }, options, deps);
}

export async function runStatus(id: string, options: { format?: OutputFormat }, deps: CommandDeps): Promise<number> {
  const job = await deps.jobStore.load(id);
  const response = await deps.api.retrieveResponse(job.responseId);
  await saveIfLocalJob(deps.jobStore, updateJobFromResponse(job, response));

  const payload = responsePayload(job, response);
  if ((options.format ?? "text") === "json") {
    deps.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    deps.stdout.write(`${job.jobId}: ${payload.status} (${job.responseId})\n`);
    if (payload.error) deps.stdout.write(`${payload.error}\n`);
  }
  return 0;
}

export async function runCancel(id: string, options: { format?: OutputFormat }, deps: CommandDeps): Promise<number> {
  const job = await deps.jobStore.load(id);
  const response = await deps.api.cancelResponse(job.responseId);
  await saveIfLocalJob(deps.jobStore, updateJobFromResponse(job, response));

  const payload = responsePayload(job, response);
  if ((options.format ?? "text") === "json") {
    deps.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    deps.stdout.write(`${job.jobId}: ${payload.status} (${job.responseId})\n`);
  }
  return 0;
}

async function waitForJob(
  job: JobRecord,
  options: Pick<AskOptions, "timeout" | "pollInterval" | "format" | "output" | "cancelOnInterrupt" | "registerSignals">,
  deps: CommandDeps,
  context?: ContextBundle
): Promise<number> {
  const timeoutMs = parseDurationMs(options.timeout ?? "60m");
  const pollIntervalMs = parseDurationMs(options.pollInterval ?? "5s");
  const startedAt = Date.now();
  let interrupted = false;

  const onInterrupt = () => {
    interrupted = true;
  };

  if (options.registerSignals !== false) {
    process.once("SIGINT", onInterrupt);
  }

  try {
    const finalResponse = await pollResponse(deps.api, job.responseId, {
      timeoutMs,
      pollIntervalMs,
      shouldStop: () => interrupted,
      onPoll: async (response) => {
        await saveIfLocalJob(deps.jobStore, updateJobFromResponse(job, response));
        deps.stderr.write(`Status ${normalizeStatus(response.status)} after ${formatElapsed(Date.now() - startedAt)}.\n`);
      }
    });

    const updated = updateJobFromResponse(job, finalResponse);
    await saveIfLocalJob(deps.jobStore, updated);

    if (normalizeStatus(finalResponse.status) !== "completed") {
      deps.stderr.write(`${terminalErrorMessage(finalResponse)}\n`);
      return 1;
    }

    await writeFinalResponse(finalResponse, updated, options.format ?? updated.format, deps);
    return 0;
  } catch (error) {
    if (options.registerSignals !== false) {
      process.removeListener("SIGINT", onInterrupt);
    }

    if (interrupted) {
      if (options.cancelOnInterrupt) {
        const cancelled = await deps.api.cancelResponse(job.responseId);
        await saveIfLocalJob(deps.jobStore, updateJobFromResponse(job, cancelled));
        deps.stderr.write(`Cancelled ${job.jobId} (${job.responseId}).\n`);
        return 130;
      }
      await saveIfLocalJob(deps.jobStore, { ...job, status: "interrupted" });
      deps.stderr.write(`Interrupted. Response is still running; resume with: expert resume ${job.jobId}\n`);
      return 130;
    }

    if (error instanceof PollTimeoutError) {
      if (error.response) {
        await saveIfLocalJob(deps.jobStore, updateJobFromResponse(job, error.response));
      }
      deps.stderr.write(`Timed out after ${formatElapsed(timeoutMs)}. Resume with: expert resume ${job.jobId}\n`);
      return 124;
    }

    await saveIfLocalJob(deps.jobStore, {
      ...job,
      status: "error",
      lastError: error instanceof Error ? error.message : String(error)
    });
    throw error;
  } finally {
    if (options.registerSignals !== false) {
      process.removeListener("SIGINT", onInterrupt);
    }
    void context;
  }
}

async function writeFinalResponse(response: ResponseLike, job: JobRecord, format: OutputFormat, deps: CommandDeps): Promise<void> {
  const text = extractOutputText(response);
  const payload = responsePayload(job, response, text);

  if (job.outputPath) {
    const content = format === "json" ? `${JSON.stringify(payload, null, 2)}\n` : `${text}\n`;
    await writeFile(job.outputPath, content, "utf8");
  }

  if (format === "json") {
    deps.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    deps.stdout.write(`${text}\n`);
  }
}

function responsePayload(job: JobRecord, response: ResponseLike, outputText = extractOutputText(response)) {
  return {
    job_id: job.jobId,
    response_id: job.responseId,
    model: job.model,
    reasoning_effort: job.reasoningEffort,
    status: normalizeStatus(response.status),
    output_text: outputText,
    error: response.error?.message ?? null,
    incomplete_reason: response.incomplete_details?.reason ?? null,
    usage: response.usage ?? null,
    uploaded_files: job.uploadedFiles,
    skipped_files: job.skippedFiles
  };
}

function writePayload(stdout: NodeJS.WritableStream, format: OutputFormat, jsonPayload: unknown, textPayload: string): void {
  if (format === "json") {
    stdout.write(`${JSON.stringify(jsonPayload, null, 2)}\n`);
  } else {
    stdout.write(`${textPayload}\n`);
  }
}

async function saveIfLocalJob(jobStore: JobStore, job: JobRecord): Promise<void> {
  if (job.jobId.startsWith("resp_")) return;
  await jobStore.save(job);
}
