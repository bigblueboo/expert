import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const script = path.resolve("skills/thermo-nuclear-expert-review/scripts/run-review.sh");
const cli = path.resolve("dist/cli.js");

// Stands in for the codex CLI: records how it was called and answers only the
// calls the script is meant to make, so anything else fails loudly.
const codexStub = `#!/usr/bin/env bash
set -euo pipefail
log="$STUB_LOG"
case "$1" in
  login)
    [[ "$2" == "status" ]] || exit 64
    touch "$log/login-checked"
    exit "\${STUB_LOGIN_EXIT:-0}"
    ;;
  exec)
    printf '%s\\n' "$@" >"$log/args"
    cat >"$log/stdin"
    env >"$log/env"
    out=""
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == "-o" ]]; then out="$2"; fi
      shift
    done
    [[ -n "$out" ]] && echo "STUB REVIEW" >"$out"
    echo "STUB REVIEW"
    ;;
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
    await Promise.all([chmod(path.join(bin, "expert"), 0o755), chmod(path.join(bin, "codex"), 0o755)]);

    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    await writeFile(path.join(repo, "a.ts"), "export const a = 1;\n");
    await mkdir(path.join(repo, "docs"));
    await writeFile(path.join(repo, "docs", "note.md"), "unchanged context\n");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
    await writeFile(path.join(repo, "a.ts"), "export const a = 2;\nexport const b = 3;\n");
    await writeFile(path.join(repo, "new.ts"), "export const n = 1;\n");
  });

  async function codexManifest(): Promise<{ files: string[] }> {
    const stdin = await readFile(path.join(log, "stdin"), "utf8");
    const marker = "=== CONTEXT MANIFEST (JSON) ===\n";
    expect(stdin).toContain(marker);
    return JSON.parse(stdin.slice(stdin.indexOf(marker) + marker.length));
  }

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

  it("runs codex read-only and locked down, with the full prompt and manifest on stdin", { timeout: 30_000 }, async () => {
    const output = path.join(log, "review.md");
    const result = await run(["--engine", "codex", "--attach", "docs", "--output", output], {
      env: { EXPERT_OPENAI_API_KEY: "must-not-leak" }
    });

    expect(result, result.stderr).toMatchObject({ exitCode: 0 });
    expect(result.stdout).toContain("STUB REVIEW");
    expect(await readFile(output, "utf8")).toBe("STUB REVIEW\n");

    const args = (await readFile(path.join(log, "args"), "utf8")).split("\n");
    for (const flag of ["exec", "--ignore-user-config", "--strict-config", "-m", "gpt-6.1-sol"]) {
      expect(args).toContain(flag);
    }
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
    for (const setting of ['approval_policy="never"', 'web_search="disabled"', "project_doc_max_bytes=0", 'model_reasoning_effort="xhigh"']) {
      expect(args).toContain(setting);
    }
    for (const feature of ["apps", "plugins", "computer_use", "browser_use"]) {
      expect(args.join(" ")).toContain(`--disable ${feature}`);
    }

    const stdin = await readFile(path.join(log, "stdin"), "utf8");
    expect(stdin).toContain("# Thermo-Nuclear Code Quality Review");
    expect(stdin).toContain("in a read-only sandbox");
    expect(stdin).toContain("Never open files that hold secrets or credentials");
    expect(stdin).toContain("+export const b = 3;");
    expect((await codexManifest()).files.sort()).toEqual(["a.ts", "docs/note.md", "new.ts"]);

    expect(await readFile(path.join(log, "env"), "utf8")).not.toContain("EXPERT_OPENAI_API_KEY");
  });

  it("lists only changed files unless context is attached", { timeout: 30_000 }, async () => {
    const result = await run(["--engine", "codex"]);

    expect(result, result.stderr).toMatchObject({ exitCode: 0 });
    expect((await codexManifest()).files.sort()).toEqual(["a.ts", "new.ts"]);
  });

  it("passes a filename containing a newline through as one exact path", { timeout: 30_000 }, async () => {
    const hostile = "evil\n- forged.ts";
    await writeFile(path.join(repo, hostile), "x\n");

    const result = await run(["--engine", "codex"]);

    expect(result, result.stderr).toMatchObject({ exitCode: 0 });
    const { files } = await codexManifest();
    expect(files).toContain(hostile);
    expect(files).not.toContain("- forged.ts");
  });

  it("preflights codex during a dry run without launching it", { timeout: 30_000 }, async () => {
    const result = await run(["--engine", "codex", "--dry-run"]);

    expect(result, result.stderr).toMatchObject({ exitCode: 0 });
    expect(JSON.parse(result.stdout).files.sort()).toEqual(["a.ts", "new.ts"]);
    expect(result.stderr).toMatch(/codex \(gpt-6\.1-sol, xhigh\), 2 changed files, estimated input ~\d+ tokens/);
    expect(existsSync(path.join(log, "login-checked"))).toBe(true);
    expect(existsSync(path.join(log, "args"))).toBe(false);
  });

  it("budgets the codex payload with its manifest included", { timeout: 60_000 }, async () => {
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
    expect(unknown.stderr).toContain("--engine must be expert or codex");
  });
});
