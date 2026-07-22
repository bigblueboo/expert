import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import { runAsk, runCancel, runResume, runStatus } from "../src/commands.js";
import { resolveContext } from "../src/context.js";
import { JobStore } from "../src/jobs.js";
import type { OpenAIAdapter, ResponseLike, UploadedFile } from "../src/types.js";

class MockOpenAI implements OpenAIAdapter {
  uploads: string[] = [];
  uploadNames: string[] = [];
  deletedFileIds: string[] = [];
  createdBodies: ResponseCreateParamsNonStreaming[] = [];
  retrieveQueue: ResponseLike[] = [];
  cancelResponseValue: ResponseLike = { id: "resp_mock", status: "cancelled" };
  failUploadsMatching: RegExp | null = null;

  async uploadFile(filePath: string, uploadName: string): Promise<UploadedFile> {
    if (this.failUploadsMatching?.test(filePath)) {
      throw new Error(`upload failed for ${path.basename(filePath)}`);
    }
    this.uploads.push(filePath);
    this.uploadNames.push(uploadName);
    return {
      id: `file_${this.uploads.length}`,
      filename: uploadName,
      bytes: 12
    };
  }

  async deleteFile(id: string): Promise<void> {
    this.deletedFileIds.push(id);
  }

  async createResponse(body: ResponseCreateParamsNonStreaming): Promise<ResponseLike> {
    this.createdBodies.push(body);
    return { id: "resp_mock", status: "queued" };
  }

  async retrieveResponse(id: string): Promise<ResponseLike> {
    return this.retrieveQueue.shift() ?? { id, status: "completed", output_text: "done" };
  }

  async cancelResponse(id: string): Promise<ResponseLike> {
    return { ...this.cancelResponseValue, id };
  }
}

describe("context resolution", () => {
  it("resolves explicit files and dirs while respecting ignores", async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, ".gitignore"), "ignored.md\n", "utf8");
    await writeFile(path.join(cwd, "keep.md"), "keep", "utf8");
    await writeFile(path.join(cwd, "ignored.md"), "ignored", "utf8");
    await writeFile(path.join(cwd, ".env"), "secret", "utf8");
    await mkdir(path.join(cwd, "src"));
    await writeFile(path.join(cwd, "src", "app.ts"), "export {}", "utf8");

    const context = await resolveContext({
      cwd,
      files: ["keep.md", "ignored.md", ".env"],
      dirs: ["src"]
    });

    expect(context.files.map((file) => file.relativePath)).toEqual(["keep.md", "src/app.ts"]);
    expect(context.manifest).toContain("keep.md");
    expect(context.manifest).toContain("src/app.ts");
  });

  it("resolves multiple exact files and multiple glob patterns", async () => {
    const cwd = await tempDir();
    await mkdir(path.join(cwd, "docs"));
    await mkdir(path.join(cwd, "src"));
    await mkdir(path.join(cwd, "test"));
    await writeFile(path.join(cwd, "README.md"), "readme", "utf8");
    await writeFile(path.join(cwd, "docs", "guide.md"), "guide", "utf8");
    await writeFile(path.join(cwd, "src", "app.ts"), "export {}", "utf8");
    await writeFile(path.join(cwd, "test", "app.test.ts"), "test", "utf8");

    const context = await resolveContext({
      cwd,
      files: ["README.md", "docs/guide.md", "src/**/*.ts", "test/**/*.ts"]
    });

    expect(context.files.map((file) => file.relativePath)).toEqual([
      "docs/guide.md",
      "README.md",
      "src/app.ts",
      "test/app.test.ts"
    ]);
  });
});

describe("ask command", () => {
  it("creates a background response, polls to completion, and writes the answer", async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, "notes.md"), "important context", "utf8");
    const api = new MockOpenAI();
    api.retrieveQueue = [
      { id: "resp_mock", status: "in_progress" },
      { id: "resp_mock", status: "completed", output_text: "Final answer" }
    ];
    const deps = depsFor(cwd, api);

    const code = await runAsk(["What should I do?"], {
      file: ["notes.md"],
      timeout: "1s",
      pollInterval: "1ms",
      registerSignals: false
    }, deps);

    expect(code).toBe(0);
    expect(api.uploads).toHaveLength(1);
    expect(api.createdBodies[0]).toMatchObject({
      model: "gpt-5.6",
      background: true,
      store: true,
      reasoning: { effort: "xhigh", mode: "pro" }
    });
    expect(JSON.stringify(api.createdBodies[0])).toContain("input_file");
    expect(outputOf(deps.stdout)).toContain("Final answer");
    expect(outputOf(deps.stderr)).toContain("Started job_");
  });

  it("supports dry-run without calling OpenAI", async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, "notes.md"), "important context", "utf8");
    const api = new MockOpenAI();
    const deps = depsFor(cwd, api);

    const code = await runAsk(["Inspect context"], {
      file: ["notes.md"],
      dryRun: true,
      format: "json",
      registerSignals: false
    }, deps);

    expect(code).toBe(0);
    expect(api.uploads).toHaveLength(0);
    expect(api.createdBodies).toHaveLength(0);
    const payload = JSON.parse(outputOf(deps.stdout));
    expect(payload).toMatchObject({
      model: "gpt-5.6",
      reasoning_mode: "pro",
      files: [{ path: "notes.md" }]
    });
    expect(payload.estimated_input_tokens).toBeGreaterThan(0);
    expect(payload.files[0].estimated_tokens).toBeGreaterThan(0);
  });

  it("refuses to send context estimated above the token cap", async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, "big.md"), "x".repeat(4_000), "utf8");
    const api = new MockOpenAI();
    const deps = depsFor(cwd, api);

    await expect(
      runAsk(["Review"], { file: ["big.md"], maxContextTokens: 100, registerSignals: false }, deps)
    ).rejects.toThrow(/above the --max-context-tokens cap/);
    expect(api.uploads).toHaveLength(0);
    expect(api.createdBodies).toHaveLength(0);
  });

  it("reports a cap violation as a warning on dry runs instead of failing", async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, "big.md"), "x".repeat(4_000), "utf8");
    const deps = depsFor(cwd, new MockOpenAI());

    const code = await runAsk(["Review"], {
      file: ["big.md"],
      dryRun: true,
      maxContextTokens: 100,
      registerSignals: false
    }, deps);

    expect(code).toBe(0);
    expect(outputOf(deps.stderr)).toContain("above the --max-context-tokens cap");
  });

  it("warns when estimated input crosses the pricing surcharge threshold", async () => {
    const cwd = await tempDir();
    // ~1.2MB => ~300K estimated tokens: above the 272K surcharge, below the cap.
    await writeFile(path.join(cwd, "big.md"), "x".repeat(1_200_000), "utf8");
    const api = new MockOpenAI();
    api.retrieveQueue = [{ id: "resp_mock", status: "completed", output_text: "ok" }];
    const deps = depsFor(cwd, api);

    const code = await runAsk(["Review"], {
      file: ["big.md"],
      timeout: "1s",
      pollInterval: "1ms",
      registerSignals: false
    }, deps);

    expect(code).toBe(0);
    expect(outputOf(deps.stderr)).toContain("2x input / 1.5x output");
  });
});

describe("job commands", () => {
  it("resumes, checks status, and cancels saved jobs", async () => {
    const cwd = await tempDir();
    const api = new MockOpenAI();
    const deps = depsFor(cwd, api);
    const job = await deps.jobStore.create({
      responseId: "resp_saved",
      model: "gpt-5.6",
      reasoningEffort: "xhigh",
      status: "queued",
      prompt: "prompt",
      manifest: "manifest",
      uploadedFiles: [],
      skippedFiles: [],
      format: "text"
    });

    api.retrieveQueue = [{ id: "resp_saved", status: "completed", output_text: "Saved answer" }];
    expect(await runResume(job.jobId, { timeout: "1s", pollInterval: "1ms", registerSignals: false }, deps)).toBe(0);
    expect(outputOf(deps.stdout)).toContain("Saved answer");

    resetStreams(deps);
    api.retrieveQueue = [{ id: "resp_saved", status: "completed", output_text: "Saved answer" }];
    expect(await runStatus(job.jobId, {}, deps)).toBe(0);
    expect(outputOf(deps.stdout)).toContain("completed");

    resetStreams(deps);
    expect(await runCancel(job.jobId, {}, deps)).toBe(0);
    expect(outputOf(deps.stdout)).toContain("cancelled");

    const saved = JSON.parse(await readFile(path.join(deps.jobStore.jobsDir, `${job.jobId}.json`), "utf8"));
    expect(saved.status).toBe("cancelled");
  });
});

function depsFor(cwd: string, api: OpenAIAdapter) {
  return {
    api,
    jobStore: new JobStore(path.join(cwd, ".expert")),
    cwd,
    stdout: stream(),
    stderr: stream()
  };
}

function stream(): PassThrough & { chunks: Buffer[] } {
  const writable = new PassThrough() as PassThrough & { chunks: Buffer[] };
  writable.chunks = [];
  writable.on("data", (chunk) => writable.chunks.push(Buffer.from(chunk)));
  return writable;
}

function outputOf(streamValue: NodeJS.WritableStream): string {
  const captured = streamValue as PassThrough & { chunks: Buffer[] };
  return Buffer.concat(captured.chunks).toString("utf8");
}

function resetStreams(deps: ReturnType<typeof depsFor>): void {
  deps.stdout = stream();
  deps.stderr = stream();
}

async function tempDir(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "expert-test-"));
}
