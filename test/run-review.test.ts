import { execFileSync, spawn } from "node:child_process";
import http from "node:http";
import { chmod, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const script = path.resolve("skills/thermo-nuclear-expert-review/scripts/run-review.sh");
const cli = path.resolve("dist/cli.js");

// Records an agent launch: its arguments, stdin, environment, and a copy of the
// diff file it was pointed at (the script deletes its temp dir on exit).
const recordLaunch = `
    printf '%s\\n' "$@" >"$log/args"
    cat >"$log/stdin"
    env >"$log/env"
    diff_path="$(sed -n 's/^Read it in full from: //p' "$log/stdin")"
    cp "$diff_path" "$log/diff"
    echo "STUB REVIEW"
`;

// Stand-ins for the codex and claude CLIs. Each answers only the calls the script
// is meant to make, so anything else fails loudly.
// Each stub records under its own directory, so parallel runs never share one.
const codexStub = `#!/usr/bin/env bash
set -euo pipefail
log="$STUB_LOG/codex"; mkdir -p "$log"
case "$1" in
  login)
    [[ "$2" == "status" ]] || exit 64
    touch "$log/login-checked"
    exit "\${STUB_LOGIN_EXIT:-0}"
    ;;
  exec)${recordLaunch}    ;;
  *) exit 64 ;;
esac
`;

// STUB_HANG makes claude a long foreground process, the way a real reviewer runs.
// STUB_SLOW_TERM makes it take a second to shut down on TERM, then record that.
const claudeStub = `#!/usr/bin/env bash
set -euo pipefail
log="$STUB_LOG/claude"; mkdir -p "$log"
case "$1" in
  auth) [[ "$2" == "status" ]] || exit 64; exit "\${STUB_LOGIN_EXIT:-0}" ;;
  -p)
    if [[ -n "\${STUB_SLOW_TERM:-}" ]]; then
      trap 'sleep 1; touch "$log/cleaned-up"; exit 143' TERM
      echo "$$" >"$log/hang.pid"
      while :; do sleep 0.1; done
    fi
    if [[ -n "\${STUB_HANG:-}" ]]; then
      echo "$$" >"$log/hang.pid"; exec sleep 600
    fi${recordLaunch}    ;;
  *) exit 64 ;;
esac
`;

interface Run {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

describe("run-review.sh", () => {
  let repo: string;
  let log: string;
  let bin: string;
  let codexHome: string;

  beforeEach(async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "run-review-"));
    repo = path.join(root, "repo");
    log = path.join(root, "log");
    bin = path.join(root, "bin");
    codexHome = path.join(root, "codex-home");
    await Promise.all([mkdir(repo), mkdir(log), mkdir(bin), mkdir(codexHome)]);
    await writeFile(
      path.join(codexHome, "models_cache.json"),
      JSON.stringify({ models: [{ slug: "gpt-6-astra", context_window: 272000 }, { slug: "gpt-6.1-sol", context_window: 500000 }] })
    );

    await writeFile(path.join(bin, "expert"), `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`);
    await writeFile(path.join(bin, "codex"), codexStub);
    await writeFile(path.join(bin, "claude"), claudeStub);
    for (const name of ["expert", "codex", "claude"]) await chmod(path.join(bin, name), 0o755);

    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    await writeFile(path.join(repo, "a.ts"), "export const a = 1;\n");
    await writeFile(path.join(repo, "lock.json"), '{"v": 1}\n');
    await mkdir(path.join(repo, "docs"));
    await writeFile(path.join(repo, "docs", "note.md"), "unchanged context\n");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
    await writeFile(path.join(repo, "a.ts"), "export const a = 2;\nexport const b = 3;\n");
    await writeFile(path.join(repo, "new.ts"), "export const n = 1;\n");
  });

  // Every subprocess starts from this: no provider keys or endpoint overrides from
  // the developer's shell, so nothing can reach a real API unless a test passes a
  // key and a mock endpoint together.
  function fixtureEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      STUB_LOG: log,
      CODEX_HOME: codexHome,
      EXPERT_HOME: path.join(log, "expert-home"),
      EXPERT_OPENAI_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
      OPENAI_BASE_URL: undefined,
      EXPERT_GEMINI_API_KEY: undefined,
      EXPERT_GEMINI_BASE_URL: undefined,
      GEMINI_API_KEY: undefined,
      ...overrides
    };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete env[key];
    }
    return env;
  }

  function run(args: string[], options: { cwd?: string; env?: Record<string, string | undefined> } = {}): Promise<Run> {
    const env = fixtureEnv(options.env);
    return new Promise((resolve, reject) => {
      const child = spawn("bash", [script, ...args], { cwd: options.cwd ?? repo, env, stdio: ["ignore", "pipe", "pipe"] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
      child.on("error", reject);
      child.on("close", (exitCode) =>
        resolve({ exitCode, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") })
      );
    });
  }

  const launchedAny = () => ["codex", "claude"].some((engine) => existsSync(path.join(log, engine, "args")));

  async function launched(engine: "codex" | "claude"): Promise<{ args: string[]; stdin: string; diff: string; manifest: { files: string[] } }> {
    const rec = path.join(log, engine);
    const stdin = await readFile(path.join(rec, "stdin"), "utf8");
    const marker = "=== CONTEXT MANIFEST (JSON) ===\n";
    expect(stdin).toContain(marker);
    return {
      args: (await readFile(path.join(rec, "args"), "utf8")).split("\n"),
      stdin,
      diff: await readFile(path.join(rec, "diff"), "utf8"),
      manifest: JSON.parse(stdin.slice(stdin.indexOf(marker) + marker.length))
    };
  }

  it("runs codex read-only and locked down on Astra, with the diff and manifest as paths", { timeout: 30_000 }, async () => {
    const output = path.join(log, "review.md");
    const result = await run(["--engine", "codex", "--attach", "docs", "--output", output], {
      env: { EXPERT_OPENAI_API_KEY: "must-not-leak", EXPERT_GEMINI_API_KEY: "must-not-leak", GEMINI_API_KEY: "must-not-leak", OPENAI_API_KEY: "codex-login" }
    });

    expect(result, result.stderr).toMatchObject({ exitCode: 0 });
    expect(result.stdout).toContain("STUB REVIEW");
    expect(await readFile(output, "utf8")).toBe("STUB REVIEW\n");

    const { args, stdin, diff, manifest } = await launched("codex");
    for (const flag of ["exec", "--ignore-user-config", "--strict-config", "-m", "gpt-6-astra", "model_context_window=1050000"]) {
      expect(args).toContain(flag);
    }
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
    for (const setting of ['approval_policy="never"', 'web_search="disabled"', "project_doc_max_bytes=0", 'model_reasoning_effort="xhigh"']) {
      expect(args).toContain(setting);
    }
    for (const feature of ["apps", "plugins", "computer_use", "browser_use"]) {
      expect(args.join(" ")).toContain(`--disable ${feature}`);
    }

    expect(stdin).toContain("# Thermo-Nuclear Code Quality Review");
    expect(stdin).toContain("run read-only commands");
    expect(stdin).not.toContain("+export const b = 3;");
    expect(diff).toContain("+export const b = 3;");
    expect(diff).toContain("+export const n = 1;");
    expect(manifest.files.sort()).toEqual(["a.ts", "docs/note.md", "new.ts"]);

    // Codex keeps OPENAI_API_KEY, one of its own sign-in routes, and nothing else.
    const codexEnv = await readFile(path.join(log, "codex", "env"), "utf8");
    expect(codexEnv).not.toContain("must-not-leak");
    expect(codexEnv).toMatch(/^OPENAI_API_KEY=codex-login$/m);
  });

  it("runs claude with only read tools, no settings or MCP, and secret reads denied", { timeout: 30_000 }, async () => {
    const result = await run(["--engine", "claude"], { env: { EXPERT_OPENAI_API_KEY: "must-not-leak", EXPERT_GEMINI_API_KEY: "must-not-leak", GEMINI_API_KEY: "must-not-leak", OPENAI_API_KEY: "codex-login" } });

    expect(result, result.stderr).toMatchObject({ exitCode: 0 });
    const { args, stdin, diff, manifest } = await launched("claude");
    expect(args[0]).toBe("-p");
    expect(args[1]).toContain("Perform the thermo-nuclear code quality review");
    const flagValue = (flag: string) => args[args.indexOf(flag) + 1];
    expect(flagValue("--model")).toBe("claude-fable-5-2");
    expect(flagValue("--effort")).toBe("xhigh");
    expect(flagValue("--tools")).toBe("Read,Grep,Glob");
    expect(flagValue("--permission-mode")).toBe("dontAsk");
    expect(flagValue("--setting-sources")).toBe("");
    expect(args).toContain("--strict-mcp-config");
    for (const rule of ["Read(**/.env)", "Read(**/.env.*)", "Read(**/*.pem)", "Read(**/.npmrc)"]) {
      expect(args).toContain(rule);
    }

    expect(stdin).toContain("Your tools are Read, Grep, and Glob.");
    expect(diff).toContain("+export const b = 3;");
    expect(manifest.files.sort()).toEqual(["a.ts", "new.ts"]);
    expect(await readFile(path.join(log, "claude", "env"), "utf8")).not.toMatch(/^(EXPERT_OPENAI_API_KEY|EXPERT_GEMINI_API_KEY|GEMINI_API_KEY|OPENAI_API_KEY|CLAUDECODE)=/m);
  });

  it("keeps excluded and secret changed files out of the diff and the manifest", { timeout: 30_000 }, async () => {
    await writeFile(path.join(repo, "lock.json"), '{"v": 2}\n');
    await writeFile(path.join(repo, ".env"), "TOKEN=hunter2\n");
    await writeFile(path.join(repo, ".npmrc"), "//registry/:_authToken=npm-secret\n");

    const result = await run(["--engine", "codex", "--exclude", "lock.json", "--attach", "missing/**/*.sql"]);

    expect(result, result.stderr).toMatchObject({ exitCode: 0 });
    expect(result.stderr).toContain("(3 withheld)");
    const { stdin, diff, manifest } = await launched("codex");
    for (const secret of ['"v": 2', "hunter2", "npm-secret"]) expect(diff).not.toContain(secret);
    expect(diff).toContain("+export const b = 3;");
    for (const file of ["lock.json", ".env", ".npmrc"]) expect(manifest.files).not.toContain(file);

    const marker = "--- changed but withheld from this review (JSON; excluded, secret, or unreadable) ---\n";
    const withheldJson = stdin.slice(stdin.indexOf(marker) + marker.length, stdin.indexOf("\n]\n", stdin.indexOf(marker)) + 2);
    const withheld = (JSON.parse(withheldJson) as { path: string }[]).map((entry) => entry.path).sort();
    // An unmatched attachment glob is not a changed file, so it is not reported as withheld.
    expect(withheld).toEqual([".env", ".npmrc", "lock.json"]);
  });

  it("uses Codex's own window for models other than gpt-6-astra", { timeout: 30_000 }, async () => {
    const result = await run(["--engine", "codex", "--model", "gpt-6.1-sol", "--effort", "max"]);

    expect(result, result.stderr).toMatchObject({ exitCode: 0 });
    const { args } = await launched("codex");
    expect(args).toContain("gpt-6.1-sol");
    expect(args).toContain('model_reasoning_effort="max"');
    expect(args.join(" ")).not.toContain("model_context_window");
  });

  it("sizes a newly listed Codex model from Codex's model list", { timeout: 30_000 }, async () => {
    await writeFile(
      path.join(codexHome, "models_cache.json"),
      JSON.stringify({ models: [{ slug: "gpt-6.2-sol", context_window: 100 }] })
    );
    const result = await run(["--engine", "codex", "--model", "gpt-6.2-sol", "--dry-run"]);

    expect(result, result.stderr).toMatchObject({ exitCode: 0 });
    expect(result.stderr).toContain("codex (gpt-6.2-sol, xhigh)");
    expect(result.stderr).toContain("will not fit in one gpt-6.2-sol window (100 tokens)");
    expect(result.stderr).not.toContain("not in Codex's cached model list");
  });

  it("warns, and assumes a 500k window, for a model Codex has not listed yet", { timeout: 30_000 }, async () => {
    const result = await run(["--engine", "codex", "--model", "gpt-6.2-sol", "--dry-run"]);

    expect(result, result.stderr).toMatchObject({ exitCode: 0 });
    expect(result.stderr).toContain("gpt-6.2-sol is not in Codex's cached model list");
    expect(result.stderr).not.toContain("will not fit");
  });

  it("accepts the --codex-model and --codex-effort aliases", { timeout: 30_000 }, async () => {
    const result = await run(["--engine", "codex", "--codex-model", "gpt-6.1-sol", "--codex-effort", "max", "--dry-run"]);

    expect(result, result.stderr).toMatchObject({ exitCode: 0 });
    expect(result.stderr).toContain("codex (gpt-6.1-sol, max)");
  });

  it("passes a filename containing a newline through as one exact path", { timeout: 30_000 }, async () => {
    const hostile = "evil\n- forged.ts";
    await writeFile(path.join(repo, hostile), "x\n");

    const result = await run(["--engine", "codex"]);

    expect(result, result.stderr).toMatchObject({ exitCode: 0 });
    const { manifest } = await launched("codex");
    expect(manifest.files).toContain(hostile);
    expect(manifest.files).not.toContain("- forged.ts");
  });

  it("preflights codex during a dry run without launching it", { timeout: 30_000 }, async () => {
    const result = await run(["--engine", "codex", "--dry-run"]);

    expect(result, result.stderr).toMatchObject({ exitCode: 0 });
    expect(JSON.parse(result.stdout).files.sort()).toEqual(["a.ts", "new.ts"]);
    expect(result.stderr).toMatch(/codex \(gpt-6-astra, xhigh\), 2 changed files \(0 withheld\), estimated input ~\d+ tokens/);
    expect(existsSync(path.join(log, "codex", "login-checked"))).toBe(true);
    expect(launchedAny()).toBe(false);
  });

  it("budgets an agent payload with its manifest included", { timeout: 60_000 }, async () => {
    // The engines' prompts differ by a fixed access note, so only the manifest can
    // widen the gap between their estimates as more files are listed.
    const gap = async () => {
      const estimate = async (args: string[]) => {
        const result = await run([...args, "--dry-run"]);
        expect(result, result.stderr).toMatchObject({ exitCode: 0 });
        return Number(/estimated input ~(\d+) tokens/.exec(result.stderr)?.[1]);
      };
      return (await estimate(["--engine", "codex"])) - (await estimate([]));
    };

    const before = await gap();
    for (let i = 0; i < 40; i += 1) {
      await writeFile(path.join(repo, `context-file-with-a-long-descriptive-name-${i}.md`), "x\n");
    }
    const after = await gap();

    expect(after - before).toBeGreaterThan(200);
  });

  it("stops before launching when codex is not logged in", { timeout: 30_000 }, async () => {
    const result = await run(["--engine", "codex"], { env: { STUB_LOGIN_EXIT: "1" } });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("codex is not logged in");
    expect(launchedAny()).toBe(false);
  });

  it("dry-runs the expert engine without a key but refuses to consult without one", { timeout: 30_000 }, async () => {
    const dry = await run(["--dry-run"]);
    expect(dry, dry.stderr).toMatchObject({ exitCode: 0 });
    expect(JSON.parse(dry.stdout)).toMatchObject({ model: "gpt-6-astra", reasoning_mode: "pro" });

    const real = await run([], { env: { OPENAI_API_KEY: "general-key" } });
    expect(real.exitCode).toBe(1);
    expect(real.stderr).toContain("EXPERT_OPENAI_API_KEY is not set");
  });

  it("refuses to run outside the repository root or with an unknown engine", { timeout: 30_000 }, async () => {
    const nested = await run(["--engine", "codex"], { cwd: path.join(repo, "docs") });
    expect(nested.exitCode).toBe(1);
    expect(nested.stderr).toContain("run from the repository root");

    const unknown = await run(["--engine", "bard"]);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain("--engine must be expert, gemini, codex, or claude");
  });

  it("dry-runs gemini on Carbon at high thinking, without Pro mode or a key", { timeout: 30_000 }, async () => {
    const dry = await run(["--engine", "gemini", "--dry-run"]);

    expect(dry, dry.stderr).toMatchObject({ exitCode: 0 });
    expect(JSON.parse(dry.stdout)).toMatchObject({
      provider: "gemini", model: "gemini-4-carbon", reasoning_effort: "high", reasoning_mode: "standard"
    });
    expect(dry.stderr).toContain("gemini (gemini-4-carbon, high)");

    const real = await run(["--engine", "gemini"], { env: { GEMINI_API_KEY: "general-key" } });
    expect(real.exitCode).toBe(1);
    expect(real.stderr).toContain("EXPERT_GEMINI_API_KEY is not set");
  });

  it("sends the charter, the diff, and the context to Gemini and returns its review", { timeout: 30_000 }, async () => {
    const bodies: { model: string; generation_config: unknown; input: { text: string }[] }[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        if (req.method === "POST") {
          bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          return res.end(JSON.stringify({ id: "v1_review", status: "in_progress" }));
        }
        res.end(JSON.stringify({
          id: "v1_review", status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "CARBON REVIEW" }] }]
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("mock server did not bind");
    try {
      const output = path.join(log, "gemini.md");
      const result = await run(["--engine", "gemini", "--output", output], {
        env: {
          EXPERT_GEMINI_API_KEY: "gemini-key",
          EXPERT_GEMINI_BASE_URL: `http://127.0.0.1:${address.port}/v1beta`,
          EXPERT_HOME: path.join(log, "expert-home")
        }
      });

      expect(result, result.stderr).toMatchObject({ exitCode: 0 });
      expect(result.stdout).toContain("CARBON REVIEW");
      expect(await readFile(output, "utf8")).toContain("CARBON REVIEW");
      expect(bodies[0]).toMatchObject({ model: "gemini-4-carbon", generation_config: { thinking_level: "high" } });
      const sent = bodies[0].input.map((part) => part.text).join("\n");
      expect(sent).toContain("# Thermo-Nuclear Code Quality Review");
      expect(sent).toContain("+export const b = 3;");
      expect(sent).toContain('<file path="new.ts">');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("runs several engines in parallel and collects every review", { timeout: 60_000 }, async () => {
    // Inside the repository: no run may pick up another's output as a change.
    const dir = path.join(repo, "reviews");
    const result = await run(["--engine", "claude,codex", "--output-dir", "reviews"]);

    expect(result, result.stderr).toMatchObject({ exitCode: 0 });
    expect(result.stderr).toContain("started claude codex in parallel");
    for (const engine of ["claude", "codex"] as const) {
      const { diff, manifest } = await launched(engine);
      expect(diff).toContain("+export const b = 3;");
      expect(diff).not.toContain("reviews/");
      expect(manifest.files.sort()).toEqual(["a.ts", "new.ts"]);
    }
    expect(result.stdout).toMatch(/===== claude review =====\nSTUB REVIEW[\s\S]*===== codex review =====\nSTUB REVIEW/);
    expect((await readdir(dir)).sort()).toEqual(["claude.log", "claude.md", "codex.log", "codex.md"]);
    expect(await readFile(path.join(dir, "codex.md"), "utf8")).toBe("STUB REVIEW\n");
    expect(await readFile(path.join(dir, "claude.log"), "utf8")).toContain("claude (claude-fable-5-2, xhigh)");
  });

  async function interrupt(signal: NodeJS.Signals, env: Record<string, string>) {
    const child = spawn("bash", [script, "--engine", "claude,codex", "--output-dir", "reviews"], {
      cwd: repo,
      env: fixtureEnv(env),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
    const pidFile = path.join(log, "claude", "hang.pid");
    for (let i = 0; i < 200 && !existsSync(pidFile); i += 1) await new Promise((r) => setTimeout(r, 100));
    const reviewerPid = Number(await readFile(pidFile, "utf8"));
    child.kill(signal);
    return { exitCode: await exited, stderr: Buffer.concat(stderr).toString("utf8"), reviewerPid };
  }

  it("stops every reviewer process on Ctrl-C and exits 130 without publishing", { timeout: 60_000 }, async () => {
    const { exitCode, stderr, reviewerPid } = await interrupt("SIGINT", { STUB_HANG: "1" });

    expect(exitCode).toBe(130);
    expect(stderr).toContain("interrupted (INT); every run has stopped");
    expect(() => process.kill(reviewerPid, 0)).toThrow();
    expect(existsSync(path.join(repo, "reviews"))).toBe(false);
  });

  it("waits on TERM until a reviewer has finished shutting down", { timeout: 60_000 }, async () => {
    const { exitCode, stderr, reviewerPid } = await interrupt("SIGTERM", { STUB_SLOW_TERM: "1" });

    expect(exitCode).toBe(130);
    expect(stderr).toContain("interrupted (TERM)");
    // The reviewer's cleanup ran, and it was gone, before the script reported.
    expect(existsSync(path.join(log, "claude", "cleaned-up"))).toBe(true);
    expect(() => process.kill(reviewerPid, 0)).toThrow();
  });

  it("refuses a TMPDIR or EXPERT_HOME inside the repository before launching anything", { timeout: 30_000 }, async () => {
    await mkdir(path.join(repo, "tmp"));
    // An outside home whose jobs directory is a symlink into the repository.
    const linkedHome = path.join(log, "linked-home");
    await mkdir(linkedHome);
    await symlink(path.join(repo, "tmp"), path.join(linkedHome, "jobs"));
    // An outside link into the repository, so link/.. is the repository itself.
    await mkdir(path.join(repo, "sub"));
    await symlink(path.join(repo, "sub"), path.join(log, "into-repo"));
    // Built as strings: path.join would collapse the `..` before the script sees it.
    for (const [name, value] of [
      ["TMPDIR", path.join(repo, "tmp")],
      ["TMPDIR", `${log}/into-repo/../tmp`],
      ["EXPERT_HOME", path.join(repo, "jobs", "not-yet")],
      ["EXPERT_HOME", `${log}/missing/../../${path.basename(repo)}/review-jobs`],
      ["EXPERT_HOME", linkedHome]
    ]) {
      for (const engines of ["codex", "claude,codex"]) {
        const result = await run(["--engine", engines], { env: { [name]: value } });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(`${name} (`);
        expect(result.stderr).toContain("is inside the repository");
      }
    }
    expect(launchedAny()).toBe(false);
  });

  it("refuses an --output-dir that already holds files, and a dry run writes nothing there", { timeout: 60_000 }, async () => {
    const dir = path.join(repo, "reviews");
    const dry = await run(["--engine", "claude,codex", "--output-dir", "reviews", "--dry-run"]);
    expect(dry, dry.stderr).toMatchObject({ exitCode: 0 });
    expect(dry.stderr).toContain("nothing was sent or published");
    expect(dry.stderr).not.toContain("reviews in");
    expect(existsSync(dir)).toBe(false);

    await mkdir(dir);
    await writeFile(path.join(dir, "claude.md"), "an earlier verdict\n");
    // A dry run checks the directory the same way a real run does.
    for (const extra of [["--dry-run"], []]) {
      const reused = await run(["--engine", "claude,codex", "--output-dir", "reviews", ...extra]);
      expect(reused.exitCode).toBe(1);
      expect(reused.stderr).toContain("already holds files; pass a new or empty directory");
    }
    expect(launchedAny()).toBe(false);
  });

  it("reports which parallel engines failed and still prints the rest", { timeout: 60_000 }, async () => {
    const result = await run(["--engine", "claude,gemini"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("===== claude review =====\nSTUB REVIEW");
    expect(result.stderr).toContain("EXPERT_GEMINI_API_KEY is not set");
    expect(result.stderr).toMatch(/failed: gemini; see their logs in /);
  });

  it("rejects per-engine flags and repeats in a parallel run", { timeout: 30_000 }, async () => {
    for (const [args, message] of [
      [["--engine", "claude,codex", "--model", "x"], "--model sets one engine's model"],
      [["--engine", "claude,codex", "--output", "x.md"], "pass --output-dir instead of --output"],
      [["--engine", "claude,claude"], "--engine lists claude twice"],
      [["--engine", "claude,bard"], "unknown engine 'bard'"],
      [["--engine", "claude", "--output-dir", "x"], "--output-dir is for several engines"]
    ] as const) {
      const result = await run([...args]);
      expect(result.exitCode, message).toBe(1);
      expect(result.stderr).toContain(message);
    }
    expect(launchedAny()).toBe(false);
  });
});
