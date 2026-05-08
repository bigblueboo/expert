import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { JobRecord } from "./types.js";

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
  jobId: z.string(),
  responseId: z.string(),
  model: z.string(),
  reasoningEffort: z.enum(["medium", "high", "xhigh"]),
  status: z.string(),
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
      jobId: `job_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
      createdAt: now,
      updatedAt: now
    };
    await this.save(job);
    return job;
  }

  async save(record: JobRecord): Promise<void> {
    await mkdir(this.jobsDir, { recursive: true });
    const updated: JobRecord = { ...record, updatedAt: new Date().toISOString() };
    const target = this.pathForJob(updated.jobId);
    const temp = `${target}.tmp`;
    await writeFile(temp, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
    await rename(temp, target);
  }

  async load(id: string): Promise<JobRecord> {
    if (id.startsWith("resp_")) {
      const byResponse = await this.findByResponseId(id);
      if (byResponse) return byResponse;
      return jobRecordSchema.parse({
        jobId: id,
        responseId: id,
        model: "unknown",
        reasoningEffort: "xhigh",
        status: "unknown",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        prompt: "",
        manifest: "",
        uploadedFiles: [],
        skippedFiles: [],
        format: "text"
      });
    }

    const raw = await readFile(this.pathForJob(id), "utf8");
    return jobRecordSchema.parse(JSON.parse(raw));
  }

  private async findByResponseId(responseId: string): Promise<JobRecord | null> {
    try {
      const entries = await readdir(this.jobsDir);
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const raw = await readFile(path.join(this.jobsDir, entry), "utf8");
        const parsed = jobRecordSchema.safeParse(JSON.parse(raw));
        if (parsed.success && parsed.data.responseId === responseId) {
          return parsed.data;
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  private pathForJob(jobId: string): string {
    return path.join(this.jobsDir, `${jobId}.json`);
  }
}

export function defaultExpertHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.EXPERT_HOME) return path.resolve(env.EXPERT_HOME);
  const home = env.HOME || env.USERPROFILE;
  if (!home) throw new Error("Cannot determine home directory. Set EXPERT_HOME.");
  return path.join(home, ".expert");
}
