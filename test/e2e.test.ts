import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

class MockOpenAIServer {
  readonly requests: CapturedRequest[] = [];
  readonly createBodies: unknown[] = [];
  private server: http.Server | null = null;
  private retrieveCount = 0;
  private fileCount = 0;

  async start(): Promise<string> {
    this.server = http.createServer(async (req, res) => {
      const body = await readBody(req);
      this.requests.push({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers,
        body
      });

      if (req.method === "POST" && routeIs(req.url, "/files")) {
        this.fileCount += 1;
        writeJson(res, 200, {
          id: `file_e2e_${this.fileCount}`,
          object: "file",
          bytes: Buffer.byteLength(body),
          created_at: Math.floor(Date.now() / 1000),
          filename: `attachment-${this.fileCount}.txt`,
          purpose: "user_data"
        });
        return;
      }

      if (req.method === "POST" && routeIs(req.url, "/responses")) {
        const parsed = JSON.parse(body);
        this.createBodies.push(parsed);
        writeJson(res, 200, {
          id: "resp_e2e",
          object: "response",
          created_at: Math.floor(Date.now() / 1000),
          status: "queued",
          output: []
        });
        return;
      }

      if (req.method === "GET" && routeIs(req.url, "/responses/resp_e2e")) {
        this.retrieveCount += 1;
        const completed = this.retrieveCount >= 2;
        writeJson(res, 200, {
          id: "resp_e2e",
          object: "response",
          created_at: Math.floor(Date.now() / 1000),
          status: completed ? "completed" : "in_progress",
          output: completed
            ? [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "E2E final answer" }]
                }
              ]
            : []
        });
        return;
      }

      if (req.method === "POST" && routeIs(req.url, "/responses/resp_e2e/cancel")) {
        writeJson(res, 200, {
          id: "resp_e2e",
          object: "response",
          created_at: Math.floor(Date.now() / 1000),
          status: "cancelled",
          output: []
        });
        return;
      }

      writeJson(res, 404, { error: { message: `No route for ${req.method} ${req.url}` } });
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(0, "127.0.0.1", resolve);
    });

    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Mock server did not bind to a TCP port.");
    }
    return `http://127.0.0.1:${address.port}/v1`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server!.close((error) => (error ? reject(error) : resolve()));
    });
    this.server = null;
  }
}

describe("CLI e2e", () => {
  let server: MockOpenAIServer;
  let baseURL: string;
  let cwd: string;
  let expertHome: string;

  beforeEach(async () => {
    server = new MockOpenAIServer();
    baseURL = await server.start();
    cwd = await mkdtemp(path.join(os.tmpdir(), "expert-e2e-cwd-"));
    expertHome = path.join(cwd, ".expert");
    await writeFile(path.join(cwd, "notes.md"), "local context", "utf8");
  });

  afterEach(async () => {
    await server.stop();
  });

  it("asks with an attached file, uses xhigh by default, persists a job, and supports status/cancel", async () => {
    const ask = await runCli(
      ["ask", "Consult on this", "--file", "notes.md", "--timeout", "3s", "--poll-interval", "1ms", "--format", "json"],
      { cwd, baseURL, expertHome }
    );

    expect(ask, `${ask.stderr}\n${ask.stdout}`).toMatchObject({ exitCode: 0 });
    expect(ask.stderr).toContain("Started job_");
    const askJson = JSON.parse(ask.stdout);
    expect(askJson).toMatchObject({
      response_id: "resp_e2e",
      status: "completed",
      output_text: "E2E final answer",
      reasoning_effort: "xhigh"
    });

    expect(server.createBodies).toHaveLength(1);
    expect(server.createBodies[0]).toMatchObject({
      model: "gpt-5.6",
      background: true,
      store: true,
      reasoning: { effort: "xhigh", mode: "pro" }
    });
    expect(JSON.stringify(server.createBodies[0])).toContain("input_file");

    const status = await runCli(["status", askJson.job_id, "--format", "json"], { cwd, baseURL, expertHome });
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      response_id: "resp_e2e",
      status: "completed"
    });

    const cancel = await runCli(["cancel", askJson.job_id, "--format", "json"], { cwd, baseURL, expertHome });
    expect(cancel.exitCode).toBe(0);
    expect(JSON.parse(cancel.stdout)).toMatchObject({
      response_id: "resp_e2e",
      status: "cancelled"
    });

    const jobRecord = JSON.parse(await readFile(path.join(expertHome, "jobs", `${askJson.job_id}.json`), "utf8"));
    expect(jobRecord).toMatchObject({
      responseId: "resp_e2e",
      reasoningEffort: "xhigh",
      status: "cancelled"
    });
  });
});

function runCli(args: string[], options: { cwd: string; baseURL: string; expertHome: string }): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve("dist/cli.js"), ...args], {
      cwd: options.cwd,
      env: {
        ...process.env,
        OPENAI_API_KEY: "test-key",
        OPENAI_BASE_URL: options.baseURL,
        EXPERT_HOME: options.expertHome
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function writeJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function routeIs(url: string | undefined, route: string): boolean {
  return url === route || url === `/v1${route}`;
}
