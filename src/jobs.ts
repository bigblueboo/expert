import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { JOB_STATUSES, PROVIDERS, REASONING_EFFORTS, REASONING_MODES } from "./types.js";
import type { JobRecord, JobRef, Provider, ResponseLike } from "./types.js";
import { normalizeStatus } from "./output.js";

const uploadedFileSchema = z.object({
  id: z.string(),
  filename: z.string(),
  bytes: z.number()
});

const skippedFileSchema = z.object({
  path: z.string(),
  reason: z.string()
});

const jobRecordSchema: z.ZodType<JobRecord> = z.object({
  schemaVersion: z.number().optional(),
  jobId: z.string(),
  responseId: z.string(),
  provider: z.enum(PROVIDERS).optional(),
  model: z.string(),
  reasoningEffort: z.enum(REASONING_EFFORTS),
  reasoningMode: z.enum(REASONING_MODES).optional(),
  status: z.enum(JOB_STATUSES),
  createdAt: z.string(),
  updatedAt: z.string(),
  prompt: z.string(),
  manifest: z.string(),
  uploadedFiles: z.array(uploadedFileSchema),
  skippedFiles: z.array(skippedFileSchema),
  outputPath: z.string().optional(),
  format: z.enum(["text", "json"]),
  lastError: z.string().optional()
});

export class JobStore {
  readonly jobsDir: string;

  constructor(homeDir: string) {
    this.jobsDir = path.join(homeDir, "jobs");
  }

  async create(record: Omit<JobRecord, "jobId" | "createdAt" | "updatedAt">): Promise<JobRecord> {
    const now = new Date().toISOString();
    const job: JobRecord = {
      ...record,
      schemaVersion: 1,
      jobId: `job_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
      createdAt: now,
      updatedAt: now
    };
    await this.save(job);
    return job;
  }

  async save(record: JobRecord): Promise<void> {
    // Records contain full prompts and stdin content; keep them private.
    await mkdir(this.jobsDir, { recursive: true, mode: 0o700 });
    const updated: JobRecord = { ...record, updatedAt: new Date().toISOString() };
    const target = this.pathForJob(updated.jobId);
    const temp = `${target}.tmp`;
    await writeFile(temp, `${JSON.stringify(updated, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temp, target);
  }

  // `provider` names the provider of a raw id that has no saved record, and must
  // agree with a saved record's provider when there is one.
  async load(id: string, provider?: Provider): Promise<JobRef> {
    if (id.startsWith("job_")) {
      const record = jobRecordSchema.parse(JSON.parse(await readFile(this.pathForJob(id), "utf8")));
      return refForRecord(record, provider);
    }
    this.pathForJob(id); // same character rules as a job id, so nothing odd reaches the search
    const record = await this.findByResponseId(id);
    if (record) return refForRecord(record, provider);
    if (provider) return { provider, responseId: id };
    if (id.startsWith("resp_")) return { provider: "openai", responseId: id };
    throw new Error(`No saved job for ${id}; for a raw Gemini interaction id, pass --provider gemini.`);
  }

  private async findByResponseId(responseId: string): Promise<JobRecord | null> {
    let entries: string[];
    try {
      entries = await readdir(this.jobsDir);
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      // A single corrupt record must not abort the search.
      try {
        const raw = await readFile(path.join(this.jobsDir, entry), "utf8");
        const parsed = jobRecordSchema.safeParse(JSON.parse(raw));
        if (parsed.success && parsed.data.responseId === responseId) {
          return parsed.data;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  private pathForJob(jobId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(jobId)) {
      throw new Error(`Invalid job id: ${jobId}`);
    }
    const target = path.join(this.jobsDir, `${jobId}.json`);
    if (path.dirname(target) !== this.jobsDir) {
      throw new Error(`Invalid job id: ${jobId}`);
    }
    return target;
  }
}

// Records written before Gemini support carry no provider; they are OpenAI.
function refForRecord(record: JobRecord, requested?: Provider): JobRef {
  const provider = record.provider ?? "openai";
  if (requested && requested !== provider) {
    throw new Error(`Job ${record.jobId} (${record.responseId}) is a ${provider} job, not ${requested}.`);
  }
  return { provider, responseId: record.responseId, record };
}

export function updateJobFromResponse(job: JobRecord, response: ResponseLike): JobRecord {
  return {
    ...job,
    status: normalizeStatus(response.status),
    lastError: response.error?.message ?? job.lastError
  };
}

export function defaultExpertHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.EXPERT_HOME) return path.resolve(env.EXPERT_HOME);
  const home = env.HOME || env.USERPROFILE;
  if (!home) throw new Error("Cannot determine home directory. Set EXPERT_HOME.");
  return path.join(home, ".expert");
}
