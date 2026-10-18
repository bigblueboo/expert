import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
const codexStub = `#!/usr/bin/env bash
set -euo pipefail
log="$STUB_LOG"
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

const claudeStub = `#!/usr/bin/env bash
set -euo pipefail
log="$STUB_LOG"
case "$1" in
  auth) [[ "$2" == "status" ]] || exit 64; exit "\${STUB_LOGIN_EXIT:-0}" ;;
  -p)${recordLaunch}    ;;
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

  beforeEach(async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "run-review-"));
    repo = path.join(root, "repo");
    log = path.join(root, "log");
    bin = path.join(root, "bin");
    await Promise.all([mkdir(repo), mkdir(log), mkdir(bin)]);

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

  function run(args: string[], options: { cwd?: string; env?: Record<string, string | undefined> } = {}): Promise<Run> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      STUB_LOG: log,
      EXPERT_OPENAI_API_KEY: undefined,
      ...options.env
    };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete env[key];
    }
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

  async function launched(): Promise<{ args: string[]; stdin: string; diff: string; manifest: { files: string[] } }> {
    const stdin = await readFile(path.join(log, "stdin"), "utf8");
    const marker = "=== CONTEXT MANIFEST (JSON) ===\n";
    expect(stdin).toContain(marker);
    return {
      args: (await readFile(path.join(log, "args"), "utf8")).split("\n"),
      stdin,
      diff: await readFile(path.join(log, "diff"), "utf8"),
      manifest: JSON.parse(stdin.slice(stdin.indexOf(marker) + marker.length))
    };
  }

  it("runs codex read-only and locked down on Astra, with the diff and manifest as paths", { timeout: 30_000 }, async () => {
    const output = path.join(log, "review.md");
    const result = await run(["--engine", "codex", "--attach", "docs", "--output", output], {
      env: { EXPERT_OPENAI_API_KEY: "must-not-leak" }
    });

    expect(result, result.stderr).toMatchObject({ exitCode: 0 });
    expect(result.stdout).toContain("STUB REVIEW");
    expect(await readFile(output, "utf8")).toBe("STUB REVIEW\n");

    const { args, stdin, diff, manifest } = await launched();
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

    expect(await readFile(path.join(log, "env"), "utf8")).not.toContain("EXPERT_OPENAI_API_KEY");
  });

  it("runs claude with only read tools, no settings or MCP, and secret reads denied", { timeout: 30_000 }, async () => {
    const result = await run(["--engine", "claude"], { env: { EXPERT_OPENAI_API_KEY: "must-not-leak" } });

    expect(result, result.stderr).toMatchObject({ exitCode: 0 });
    const { args, stdin, diff, manifest } = await launched();
    expect(args[0]).toBe("-p");
    expect(args[1]).toContain("Perform the thermo-nuclear code quality review");
    const flagValue = (flag: string) => args[args.indexOf(flag) + 1];
    expect(flagValue("--model")).toBe("claude-fable-5-1");
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
    expect(await readFile(path.join(log, "env"), "utf8")).not.toMatch(/^(EXPERT_OPENAI_API_KEY|CLAUDECODE)=/m);
  });

  it("keeps excluded and secret changed files out of the diff and the manifest", { timeout: 30_000 }, async () => {
    await writeFile(path.join(repo, "lock.json"), '{"v": 2}\n');
    await writeFile(path.join(repo, ".env"), "TOKEN=hunter2\n");
    await writeFile(path.join(repo, ".npmrc"), "//registry/:_authToken=npm-secret\n");

    const result = await run(["--engine", "codex", "--exclude", "lock.json", "--attach", "missing/**/*.sql"]);

    expect(result, result.stderr).toMatchObject({ exitCode: 0 });
    expect(result.stderr).toContain("(3 withheld)");
    const { stdin, diff, manifest } = await launched();
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
    const { args } = await launched();
    expect(args).toContain("gpt-6.1-sol");
    expect(args).toContain('model_reasoning_effort="max"');
    expect(args.join(" ")).not.toContain("model_context_window");
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
    const { manifest } = await launched();
    expect(manifest.files).toContain(hostile);
    expect(manifest.files).not.toContain("- forged.ts");
  });

  it("preflights codex during a dry run without launching it", { timeout: 30_000 }, async () => {
    const result = await run(["--engine", "codex", "--dry-run"]);

    expect(result, result.stderr).toMatchObject({ exitCode: 0 });
    expect(JSON.parse(result.stdout).files.sort()).toEqual(["a.ts", "new.ts"]);
    expect(result.stderr).toMatch(/codex \(gpt-6-astra, xhigh\), 2 changed files \(0 withheld\), estimated input ~\d+ tokens/);
    expect(existsSync(path.join(log, "login-checked"))).toBe(true);
    expect(existsSync(path.join(log, "args"))).toBe(false);
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
    expect(existsSync(path.join(log, "args"))).toBe(false);
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

    const unknown = await run(["--engine", "gemini"]);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain("--engine must be expert, codex, or claude");
  });
});
