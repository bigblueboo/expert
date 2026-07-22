#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Command, Option } from "commander";
import { runAsk, runCancel, runResume, runStatus } from "./commands.js";
import {
  DEFAULT_MAX_CONTEXT_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_MODEL_DISPLAY_NAME,
  DEFAULT_POLL_INTERVAL,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_TIMEOUT,
  MODEL_CONTEXT_WINDOW_TOKENS
} from "./defaults.js";
import { defaultExpertHome, JobStore } from "./jobs.js";
import { OpenAISdkAdapter } from "./openai-adapter.js";
import { REASONING_EFFORTS, REASONING_MODES } from "./types.js";
import type { OutputFormat, ReasoningEffort, ReasoningMode } from "./types.js";

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name("expert")
    .description(`Consult ${DEFAULT_MODEL_DISPLAY_NAME} with explicit local context and resumable background polling.`)
    .version(packageVersion());

  program
    .command("ask")
    .description(`Start a blocking ${DEFAULT_MODEL_DISPLAY_NAME} consultation.`)
    .argument("[prompt...]", "Prompt text to send.")
    .option("-f, --file <pathOrGlob>", "Attach a file or glob. Repeat for multiple files/globs.", collect, [])
    .option("-d, --dir <path>", "Attach files under a directory. Repeatable.", collect, [])
    .option("--exclude <glob>", "Exclude files matching a glob. Repeatable.", collect, [])
    .option("--stdin", "Read additional prompt/context from stdin.")
    .option("--dry-run", "Show resolved context without calling OpenAI.")
    .option("--model <model>", "Model to use.", DEFAULT_MODEL)
    .addOption(new Option("--reasoning <effort>", "Reasoning effort.").choices(REASONING_EFFORTS).default(DEFAULT_REASONING_EFFORT))
    .addOption(new Option("--reasoning-mode <mode>", "Reasoning execution mode (default: pro for GPT-5.6 models, standard otherwise).").choices(REASONING_MODES))
    .option("--timeout <duration>", "Maximum time to block while polling.", DEFAULT_TIMEOUT)
    .option("--poll-interval <duration>", "Polling interval.", DEFAULT_POLL_INTERVAL)
    .addOption(new Option("--format <format>", "Output format.").choices(["text", "json"]).default("text"))
    .option("-o, --output <path>", "Write final answer to a file.")
    .option("--max-output-tokens <n>", "Maximum output tokens.", parseInteger)
    .option(
      "--max-context-tokens <n>",
      `Refuse to send when estimated input tokens exceed this (model window: ${MODEL_CONTEXT_WINDOW_TOKENS.toLocaleString("en-US")}).`,
      parseInteger,
      DEFAULT_MAX_CONTEXT_TOKENS
    )
    .option("--cancel-on-interrupt", "Cancel the background response on Ctrl-C.")
    .action(async (prompt: string[], opts) => {
      await runWithDeps((deps) =>
        runAsk(prompt, {
          ...opts,
          reasoning: opts.reasoning as ReasoningEffort,
          reasoningMode: opts.reasoningMode as ReasoningMode,
          format: opts.format as OutputFormat
        }, deps)
      );
    });

  program
    .command("resume")
    .description("Resume polling a saved job id or raw response id.")
    .argument("<jobIdOrResponseId>")
    .option("--timeout <duration>", "Maximum time to block while polling.", DEFAULT_TIMEOUT)
    .option("--poll-interval <duration>", "Polling interval.", DEFAULT_POLL_INTERVAL)
    .addOption(new Option("--format <format>", "Output format.").choices(["text", "json"]))
    .option("-o, --output <path>", "Write final answer to a file.")
    .option("--cancel-on-interrupt", "Cancel the background response on Ctrl-C.")
    .action(async (id: string, opts) => {
      await runWithDeps((deps) =>
        runResume(id, { ...opts, format: opts.format as OutputFormat | undefined }, deps)
      );
    });

  program
    .command("status")
    .description("Retrieve current status for a saved job id or raw response id.")
    .argument("<jobIdOrResponseId>")
    .addOption(new Option("--format <format>", "Output format.").choices(["text", "json"]).default("text"))
    .action(async (id: string, opts) => {
      await runWithDeps((deps) => runStatus(id, { format: opts.format as OutputFormat }, deps));
    });

  program
    .command("cancel")
    .description("Cancel a background response for a saved job id or raw response id.")
    .argument("<jobIdOrResponseId>")
    .addOption(new Option("--format <format>", "Output format.").choices(["text", "json"]).default("text"))
    .action(async (id: string, opts) => {
      await runWithDeps((deps) => runCancel(id, { format: opts.format as OutputFormat }, deps));
    });

  return program;
}

async function runWithDeps(action: (deps: ReturnType<typeof createDeps>) => Promise<number>): Promise<void> {
  try {
    process.exitCode = await action(createDeps());
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

function createDeps() {
  return {
    api: new OpenAISdkAdapter(),
    jobStore: new JobStore(defaultExpertHome()),
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr
  };
}

export function parseInteger(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid positive integer: ${value}`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer: ${value}`);
  }
  return parsed;
}

function packageVersion(): string {
  const pkg = createRequire(import.meta.url)("../package.json") as { version?: string };
  return pkg.version ?? "0.0.0";
}

// Compare via file URLs so install paths with spaces or unusual characters
// still match, and resolve symlinks so npm bin shims are recognized.
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  await createProgram().parseAsync(process.argv);
}
