#!/usr/bin/env node
import { Command, Option } from "commander";
import { runAsk, runCancel, runResume, runStatus } from "./commands.js";
import { DEFAULT_MODEL, DEFAULT_MODEL_DISPLAY_NAME } from "./defaults.js";
import { defaultExpertHome, JobStore } from "./jobs.js";
import { OpenAISdkAdapter } from "./openai-adapter.js";
import type { OutputFormat, ReasoningEffort } from "./types.js";

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name("expert")
    .description(`Consult ${DEFAULT_MODEL_DISPLAY_NAME} with explicit local context and resumable background polling.`)
    .version("0.1.0");

  program
    .command("ask")
    .description(`Start a blocking ${DEFAULT_MODEL_DISPLAY_NAME} consultation.`)
    .argument("[prompt...]", "Prompt text to send.")
    .option("-f, --file <pathOrGlob>", "Attach a file or glob. Repeat for multiple files/globs.", collect, [])
    .option("-d, --dir <path>", "Attach files under a directory. Repeatable.", collect, [])
    .option("--include <glob>", "Attach files matching a glob. Repeatable.", collect, [])
    .option("--exclude <glob>", "Exclude files matching a glob. Repeatable.", collect, [])
    .option("--stdin", "Read additional prompt/context from stdin.")
    .option("--dry-run", "Show resolved context without calling OpenAI.")
    .option("--model <model>", "Model to use.", DEFAULT_MODEL)
    .addOption(new Option("--reasoning <effort>", "Reasoning effort.").choices(["medium", "high", "xhigh"]).default("xhigh"))
    .option("--timeout <duration>", "Maximum time to block while polling.", "60m")
    .option("--poll-interval <duration>", "Polling interval.", "5s")
    .addOption(new Option("--format <format>", "Output format.").choices(["text", "json"]).default("text"))
    .option("-o, --output <path>", "Write final answer to a file.")
    .option("--max-output-tokens <n>", "Maximum output tokens.", parseInteger)
    .option("--cancel-on-interrupt", "Cancel the background response on Ctrl-C.")
    .action(async (prompt: string[], opts) => {
      await runWithDeps((deps) =>
        runAsk(prompt, {
          ...opts,
          reasoning: opts.reasoning as ReasoningEffort,
          format: opts.format as OutputFormat
        }, deps)
      );
    });

  program
    .command("resume")
    .description("Resume polling a saved job id or raw response id.")
    .argument("<jobIdOrResponseId>")
    .option("--timeout <duration>", "Maximum time to block while polling.", "60m")
    .option("--poll-interval <duration>", "Polling interval.", "5s")
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

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer: ${value}`);
  }
  return parsed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await createProgram().parseAsync(process.argv);
}
