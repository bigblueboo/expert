import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBackends } from "../src/backends.js";
import { runAsk, runCancel, runResume, runStatus } from "../src/commands.js";
import { GeminiRestAdapter, toResponseLike } from "../src/gemini-adapter.js";
import { JobStore } from "../src/jobs.js";
import type { OpenAIAdapter } from "../src/types.js";

interface Captured {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

// Stands in for generativelanguage.googleapis.com/v1beta/interactions.
class MockGeminiServer {
  readonly requests: Captured[] = [];
  polls: Record<string, unknown>[] = [];
  dropNextPoll = false;
  // Send a poll's headers, then drop the connection before the body ends.
  truncateNextPoll = false;
  private server: http.Server | null = null;

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        this.requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
        const reply = (status: number, payload: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        if (req.method === "POST" && req.url === "/v1beta/interactions") {
          return reply(200, { id: "v1_carbon", object: "interaction", status: "in_progress" });
        }
        if (req.method === "GET" && req.url === "/v1beta/interactions/v1_carbon" && this.truncateNextPoll) {
          this.truncateNextPoll = false;
          res.writeHead(200, { "content-type": "application/json", "content-length": "500" });
          res.write('{"id": "v1_car');
          setTimeout(() => req.socket.destroy(), 20);
          return;
        }
        if (req.method === "GET" && req.url === "/v1beta/interactions/v1_carbon" && this.dropNextPoll) {
          this.dropNextPoll = false;
          req.socket.destroy();
          return;
        }
        if (req.method === "GET" && req.url === "/v1beta/interactions/v1_carbon") {
          return reply(200, this.polls.shift() ?? { id: "v1_carbon", status: "in_progress" });
        }
        if (req.method === "POST" && req.url === "/v1beta/interactions/v1_carbon/cancel") {
          return reply(200, { id: "v1_carbon", status: "cancelled" });
        }
        reply(404, { error: { message: `No route for ${req.method} ${req.url}` } });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("mock server did not bind");
    return `http://127.0.0.1:${address.port}/v1beta`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

const completed = {
  id: "v1_carbon",
  status: "completed",
  steps: [
    { type: "thought", summary: [] },
    { type: "model_output", content: [{ type: "text", text: "Carbon " }, { type: "text", text: "verdict" }] }
  ],
  usage: { total_input_tokens: 10, total_output_tokens: 3 }
};

const noOpenAI: OpenAIAdapter = {
  uploadFile: () => Promise.reject(new Error("OpenAI must not be called for Gemini models")),
  deleteFile: () => Promise.reject(new Error("OpenAI must not be called for Gemini models")),
  createResponse: () => Promise.reject(new Error("OpenAI must not be called for Gemini models")),
  retrieveResponse: () => Promise.reject(new Error("OpenAI must not be called for Gemini models")),
  cancelResponse: () => Promise.reject(new Error("OpenAI must not be called for Gemini models"))
};

describe("Gemini interactions", () => {
  let server: MockGeminiServer;
  let baseURL: string;
  let cwd: string;

  beforeEach(async () => {
    server = new MockGeminiServer();
    baseURL = await server.start();
    cwd = await mkdtemp(path.join(os.tmpdir(), "expert-gemini-"));
    await writeFile(path.join(cwd, "notes.md"), "local context", "utf8");
  });

  afterEach(async () => {
    await server.stop();
  });

  function deps() {
    return {
      backends: createBackends({ openai: noOpenAI, gemini: new GeminiRestAdapter("gemini-test-key", baseURL) }),
      jobStore: new JobStore(path.join(cwd, ".expert")),
      cwd,
      stdout: capture(),
      stderr: capture()
    };
  }

  it("runs a background interaction with inline files, high thinking, and no Pro mode", async () => {
    server.polls = [{ id: "v1_carbon", status: "in_progress" }, completed];
    const d = deps();

    const code = await runAsk(["Review this"], {
      model: "gemini-4-carbon", file: ["notes.md"], timeout: "2s", pollInterval: "1ms", format: "json", registerSignals: false
    }, d);

    expect(code, text(d.stderr)).toBe(0);
    const create = server.requests[0];
    expect(create.headers["x-goog-api-key"]).toBe("gemini-test-key");
    expect(create.headers["api-revision"]).toBe("2026-05-20");
    const body = JSON.parse(create.body);
    expect(body).toMatchObject({
      model: "gemini-4-carbon", background: true, store: true, generation_config: { thinking_level: "high" }
    });
    expect(body.input[0]).toEqual({ type: "text", text: '<file path="notes.md">\nlocal context\n</file>' });
    expect(body.input.at(-1).text).toContain("Review this");

    const payload = JSON.parse(text(d.stdout));
    expect(payload).toMatchObject({
      provider: "gemini", model: "gemini-4-carbon", reasoning_mode: "standard", status: "completed", output_text: "Carbon verdict"
    });
    const record = JSON.parse(await readFile(path.join(d.jobStore.jobsDir, `${payload.job_id}.json`), "utf8"));
    expect(record).toMatchObject({ provider: "gemini", responseId: "v1_carbon", uploadedFiles: [] });
  });

  it("routes status, cancel, and resume for a saved Gemini job to Gemini", async () => {
    const d = deps();
    await runAsk(["Review this"], {
      model: "gemini-4-carbon", timeout: "1ms", pollInterval: "1ms", format: "json", registerSignals: false
    }, d);
    const record = JSON.parse(await readFile(path.join(d.jobStore.jobsDir, (await jobFiles(d.jobStore))[0]), "utf8"));

    expect(await runStatus(record.jobId, { format: "json" }, deps())).toBe(0);
    expect(await runCancel("v1_carbon", { format: "json" }, deps())).toBe(0);
    server.polls = [completed];
    const resumed = deps();
    expect(await runResume(record.jobId, { timeout: "2s", pollInterval: "1ms", format: "text", registerSignals: false }, resumed)).toBe(0);
    expect(text(resumed.stdout)).toBe("Carbon verdict\n");
    expect(server.requests.map((r) => `${r.method} ${r.url}`)).toContain("POST /v1beta/interactions/v1_carbon/cancel");
  });

  it("keeps polling Gemini when the job record cannot be saved, and resumes the raw id", async () => {
    server.polls = [completed];
    const d = deps();
    // A file where the jobs directory should go makes every save fail.
    await writeFile(path.join(cwd, ".expert"), "not a directory", "utf8");

    expect(await runAsk(["x"], { model: "gemini-4-carbon", timeout: "2s", pollInterval: "1ms", registerSignals: false }, d)).toBe(0);
    expect(text(d.stdout)).toBe("Carbon verdict\n");
    expect(text(d.stderr)).toContain("resume with: expert resume v1_carbon --provider gemini");

    server.polls = [completed];
    const resumed = deps();
    expect(await runResume("v1_carbon", { provider: "gemini", timeout: "2s", pollInterval: "1ms", registerSignals: false }, resumed)).toBe(0);
    expect(text(resumed.stdout)).toBe("Carbon verdict\n");
    await expect(runStatus("v1_carbon", {}, deps())).rejects.toThrow("pass --provider gemini");
  });

  it.each(["dropNextPoll", "truncateNextPoll"] as const)("retries a poll whose connection fails (%s)", async (failure) => {
    server[failure] = true;
    server.polls = [completed];
    const d = deps();

    expect(await runAsk(["x"], { model: "gemini-4-carbon", timeout: "5s", pollInterval: "1ms", registerSignals: false }, d)).toBe(0);
    expect(text(d.stdout)).toBe("Carbon verdict\n");
  });

  it("leaves document formats out of a Gemini request and says why", async () => {
    await writeFile(path.join(cwd, "spec.pdf"), "%PDF-1.7 binary", "utf8");
    const d = deps();

    expect(await runAsk(["x"], { model: "gemini-4-carbon", file: ["notes.md", "spec.pdf"], dryRun: true, format: "json", registerSignals: false }, d)).toBe(0);
    const report = JSON.parse(text(d.stdout));
    expect(report.files.map((f: { path: string }) => f.path)).toEqual(["notes.md"]);
    expect(report.skipped_files).toEqual([{ path: "spec.pdf", reason: "document format; this model receives text files only" }]);
  });

  it("refuses Pro mode and max effort before sending anything", async () => {
    await expect(runAsk(["x"], { model: "gemini-4-carbon", reasoningMode: "pro", registerSignals: false }, deps()))
      .rejects.toThrow("Pro reasoning mode is OpenAI-only");
    await expect(runAsk(["x"], { model: "gemini-4-carbon", reasoning: "max", registerSignals: false }, deps()))
      .rejects.toThrow("Gemini has no max thinking level");
    await expect(runAsk(["x"], { model: "gemini-4-carbon", reasoning: "xhigh", dryRun: true, registerSignals: false }, deps()))
      .rejects.toThrow("gemini-4-carbon tops out at high thinking");
    expect(server.requests).toHaveLength(0);

    const hydrogen = deps();
    expect(await runAsk(["x"], { model: "gemini-4-hydrogen", reasoning: "xhigh", dryRun: true, format: "json", registerSignals: false }, hydrogen)).toBe(0);
    expect(JSON.parse(text(hydrogen.stdout))).toMatchObject({ reasoning_effort: "xhigh" });
  });

  it("refuses a --provider that contradicts the saved job", async () => {
    const d = deps();
    await runAsk(["x"], { model: "gemini-4-carbon", timeout: "1ms", pollInterval: "1ms", registerSignals: false }, d);
    const [file] = await jobFiles(d.jobStore);
    const jobId = file.replace(/\.json$/, "");
    for (const id of [jobId, "v1_carbon"]) {
      await expect(runStatus(id, { provider: "openai" }, deps())).rejects.toThrow("is a gemini job, not openai");
    }
    expect(await runStatus("v1_carbon", { provider: "gemini" }, deps())).toBe(0);
  });

  it("parses null fields and numeric error codes from Google", async () => {
    server.polls = [{ id: "v1_carbon", status: "failed", steps: null, errors: [{ code: 429, message: "quota" }, { code: null, message: "later" }] }];
    const response = await new GeminiRestAdapter("k", baseURL).retrieveResponse("v1_carbon");
    expect(response).toMatchObject({ status: "failed", output_text: "", error: { message: "429: quota; later" } });
  });

  it("fails fast on a malformed base URL and trims a pasted key", async () => {
    const error = await new GeminiRestAdapter("k", "not a url").retrieveResponse("v1_carbon").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as { retryable?: boolean }).retryable).toBeUndefined();

    server.polls = [completed];
    await new GeminiRestAdapter("pasted-key\n", baseURL).retrieveResponse("v1_carbon");
    expect(server.requests.at(-1)?.headers["x-goog-api-key"]).toBe("pasted-key");
  });

  it("reports the Gemini window and no OpenAI surcharge in a dry run", async () => {
    const d = deps();
    expect(await runAsk(["x"], { model: "gemini-4-carbon", dryRun: true, format: "json", registerSignals: false }, d)).toBe(0);
    expect(JSON.parse(text(d.stdout))).toMatchObject({ provider: "gemini", reasoning_effort: "high", reasoning_mode: "standard" });
    expect(server.requests).toHaveLength(0);
  });

  it("requires EXPERT_GEMINI_API_KEY and reads the base URL from the environment", { timeout: 30_000 }, async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, EXPERT_HOME: path.join(cwd, ".expert"), EXPERT_GEMINI_BASE_URL: baseURL };
    delete env.EXPERT_GEMINI_API_KEY;
    const missing = await cli(["ask", "x", "--model", "gemini-4-carbon"], { ...env, GEMINI_API_KEY: "general-key" }, cwd);
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain("EXPERT_GEMINI_API_KEY is required");
    expect(server.requests).toHaveLength(0);

    server.polls = [completed];
    const ok = await cli(["ask", "x", "--model", "gemini-4-carbon", "--poll-interval", "1ms"], { ...env, EXPERT_GEMINI_API_KEY: "k" }, cwd);
    expect(ok.exitCode, ok.stderr).toBe(0);
    expect(ok.stdout).toBe("Carbon verdict\n");
  });
});

describe("toResponseLike", () => {
  it("ends client-side statuses as incomplete with the status as the reason, and joins errors", () => {
    expect(toResponseLike({ id: "a", status: "requires_action" })).toMatchObject({
      status: "incomplete", incomplete_details: { reason: "requires_action" }
    });
    expect(toResponseLike({ id: "b", status: "failed", errors: [{ code: "x/quota", message: "out of quota" }] })).toMatchObject({
      status: "failed", error: { message: "x/quota: out of quota" }
    });
  });
});

function capture(): PassThrough & { chunks: Buffer[] } {
  const stream = new PassThrough() as PassThrough & { chunks: Buffer[] };
  stream.chunks = [];
  stream.on("data", (chunk) => stream.chunks.push(Buffer.from(chunk)));
  return stream;
}

function text(stream: NodeJS.WritableStream): string {
  return Buffer.concat((stream as PassThrough & { chunks: Buffer[] }).chunks).toString("utf8");
}

async function jobFiles(store: JobStore): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return (await readdir(store.jobsDir)).filter((name) => name.endsWith(".json"));
}

function cli(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve("dist/cli.js"), ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk) => out.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => err.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
  });
}
