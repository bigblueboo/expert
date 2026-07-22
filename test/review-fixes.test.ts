import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseInteger } from "../src/cli.js";
import { resolveContext } from "../src/context.js";
import { JobStore } from "../src/jobs.js";
import { extractOutputText } from "../src/output.js";
import { pollResponse } from "../src/poller.js";
import { prepareConsultationRequest, uploadNamesFor } from "../src/request.js";
import type { ContextBundle, ContextFile, OpenAIAdapter, ResponseLike, UploadedFile } from "../src/types.js";

describe("exclusion precedence", () => {
  it("does not let .gitignore negations re-include excluded files", async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, ".gitignore"), "!secret.txt\n!.env\n", "utf8");
    await writeFile(path.join(cwd, "secret.txt"), "secret", "utf8");
    await writeFile(path.join(cwd, ".env"), "KEY=1", "utf8");
    await writeFile(path.join(cwd, "keep.md"), "keep", "utf8");

    const context = await resolveContext({
      cwd,
      files: ["keep.md", "secret.txt", ".env"],
      excludes: ["secret.txt"]
    });

    expect(context.files.map((file) => file.relativePath)).toEqual(["keep.md"]);
    expect(context.skipped.map((entry) => entry.path).sort()).toEqual([".env", "secret.txt"]);
  });
});

describe("context resolution reporting", () => {
  it("throws for an explicitly requested file that does not exist", async () => {
    const cwd = await tempDir();
    await expect(resolveContext({ cwd, files: ["missing.md"] })).rejects.toThrow("File not found: missing.md");
  });

  it("throws for an explicitly requested directory", async () => {
    const cwd = await tempDir();
    await mkdir(path.join(cwd, "src"));
    await expect(resolveContext({ cwd, files: ["src"] })).rejects.toThrow("--dir");
  });

  it("records glob patterns that match nothing", async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, "keep.md"), "keep", "utf8");
    const context = await resolveContext({ cwd, files: ["keep.md", "src/**/*.zig"] });
    expect(context.files.map((file) => file.relativePath)).toEqual(["keep.md"]);
    expect(context.skipped).toContainEqual({ path: "src/**/*.zig", reason: "no files matched" });
  });

  it("skips symlinks instead of following them", async () => {
    const cwd = await tempDir();
    const outside = await tempDir();
    await writeFile(path.join(outside, "target.md"), "outside the repo", "utf8");
    await symlink(path.join(outside, "target.md"), path.join(cwd, "link.md"));

    const context = await resolveContext({ cwd, files: ["link.md"] });
    expect(context.files).toEqual([]);
    expect(context.skipped).toContainEqual({ path: "link.md", reason: "symbolic link (not followed)" });
  });
});

describe("upload naming", () => {
  it("derives unique names from relative paths and suffixes unsupported extensions", () => {
    const names = uploadNamesFor([
      contextFile("src/index.ts"),
      contextFile("test/index.ts"),
      contextFile("README.md")
    ]);
    expect(names).toEqual(["src__index.ts.txt", "test__index.ts.txt", "README.md"]);
  });

  it("sends file_id without filename and maps attachments in the prompt", async () => {
    const api = new RecordingAdapter();
    const bundle = bundleOf([contextFile("src/app.ts"), contextFile("docs/guide.md")]);

    const prepared = await prepareConsultationRequest(api, {
      model: "gpt-5.6",
      reasoningEffort: "xhigh",
      reasoningMode: "pro",
      prompt: "Review",
      context: bundle
    });

    const input = prepared.body.input as Array<{ content: Array<Record<string, unknown>> }>;
    const fileParts = input[0].content.filter((part) => part.type === "input_file");
    expect(fileParts).toHaveLength(2);
    for (const part of fileParts) {
      expect(part.file_id).toBeTruthy();
      expect(part).not.toHaveProperty("filename");
    }
    expect(prepared.fullPrompt).toContain("src__app.ts.txt = src/app.ts");
    expect(prepared.fullPrompt).toContain("docs__guide.md = docs/guide.md");
  });

  it("deletes already-uploaded files when a later upload fails", async () => {
    const api = new RecordingAdapter();
    api.failOn = "bad.ts";
    const bundle = bundleOf([contextFile("good.ts"), contextFile("bad.ts")]);

    await expect(
      prepareConsultationRequest(api, {
        model: "gpt-5.6",
        reasoningEffort: "xhigh",
        reasoningMode: "pro",
        prompt: "Review",
        context: bundle
      })
    ).rejects.toThrow("upload failed");
    expect(api.deleted).toEqual(api.uploaded.map((file) => file.id));
    expect(api.deleted.length).toBeGreaterThan(0);
  });
});

describe("parseInteger", () => {
  it("accepts plain positive integers only", () => {
    expect(parseInteger("42")).toBe(42);
    expect(() => parseInteger("10foo")).toThrow();
    expect(() => parseInteger("1.5")).toThrow();
    expect(() => parseInteger("0")).toThrow();
    expect(() => parseInteger("-3")).toThrow();
  });
});

describe("job store hardening", () => {
  it("rejects job ids that would escape the jobs directory", async () => {
    const store = new JobStore(await tempDir());
    await expect(store.load("../evil")).rejects.toThrow("Invalid job id");
  });

  it("skips corrupt job files when searching by response id", async () => {
    const home = await tempDir();
    const store = new JobStore(home);
    const job = await store.create({
      responseId: "resp_findme",
      model: "gpt-5.6",
      reasoningEffort: "xhigh",
      status: "queued",
      prompt: "p",
      manifest: "m",
      uploadedFiles: [],
      skippedFiles: [],
      format: "text"
    });
    await writeFile(path.join(store.jobsDir, "aaa-corrupt.json"), "{not json", "utf8");

    const ref = await store.load("resp_findme");
    expect(ref.record?.jobId).toBe(job.jobId);
  });
});

describe("poller deadline", () => {
  it("honors a timeout shorter than the poll interval", async () => {
    const api = new RecordingAdapter();
    api.retrieveResult = { id: "resp_slow", status: "in_progress" };
    const startedAt = Date.now();
    const outcome = await pollResponse(api, "resp_slow", { timeoutMs: 200, pollIntervalMs: 60_000 });
    expect(outcome.kind).toBe("timeout");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});

describe("output extraction", () => {
  it("surfaces refusal content instead of returning an empty answer", () => {
    const response: ResponseLike = {
      id: "resp_refused",
      status: "completed",
      output: [{ type: "message", content: [{ type: "refusal", refusal: "Cannot help with that." }] }]
    };
    expect(extractOutputText(response)).toBe("[refusal] Cannot help with that.");
  });
});

class RecordingAdapter implements OpenAIAdapter {
  uploaded: UploadedFile[] = [];
  deleted: string[] = [];
  failOn: string | null = null;
  retrieveResult: ResponseLike = { id: "resp_mock", status: "completed", output_text: "ok" };

  async uploadFile(filePath: string, uploadName: string): Promise<UploadedFile> {
    if (this.failOn && filePath.includes(this.failOn)) {
      throw new Error(`upload failed for ${this.failOn}`);
    }
    const file = { id: `file_${this.uploaded.length + 1}_${uploadName}`, filename: uploadName, bytes: 1 };
    this.uploaded.push(file);
    return file;
  }

  async deleteFile(id: string): Promise<void> {
    this.deleted.push(id);
  }

  async createResponse(): Promise<ResponseLike> {
    return { id: "resp_mock", status: "queued" };
  }

  async retrieveResponse(): Promise<ResponseLike> {
    return this.retrieveResult;
  }

  async cancelResponse(id: string): Promise<ResponseLike> {
    return { id, status: "cancelled" };
  }
}

function contextFile(relativePath: string): ContextFile {
  return {
    absolutePath: path.join("/tmp/fake", relativePath),
    relativePath,
    bytes: 1,
    mimeType: "text/plain"
  };
}

function bundleOf(files: ContextFile[]): ContextBundle {
  return {
    files,
    skipped: [],
    totalBytes: files.length,
    manifest: "Attached context manifest:"
  };
}

async function tempDir(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "expert-review-test-"));
}
