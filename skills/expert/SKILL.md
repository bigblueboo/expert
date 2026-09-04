---
name: expert
description: Consult GPT-6 Astra in Pro reasoning mode through the local `expert` CLI for second opinions on difficult coding tasks, architecture, debugging, implementation plans, or test strategy, using explicit local context. Use when an external API consultation that may take hours is appropriate.
---

# Expert

Use the `expert` CLI to ask GPT-6 Astra in Pro mode for a second opinion with explicit local context. The CLI uploads named files, starts a background Responses API job, polls until completion, and stores a resumable job record.

## Quick Start

Prefer the installed binary when available:

```sh
expert ask "Review this implementation for correctness and missing tests." \
  --model gpt-6-astra --reasoning-mode pro --reasoning xhigh \
  --file src/foo.ts --file test/foo.test.ts
```

If `expert` is not on `PATH`, run it via npx — no install required:

```sh
npx -y @bigblueboo/expert ask "Review this implementation for correctness and missing tests." \
  --model gpt-6-astra --reasoning-mode pro --reasoning xhigh \
  --file src/foo.ts --file test/foo.test.ts
```

These flags select Astra Pro even when an installed or published CLI still has older defaults. The remaining examples assume the updated CLI defaults; use the explicit flags above if a dry run reports a different model or mode. Preserve any model or reasoning settings explicitly chosen by the user.

## Model and Reasoning

The Responses API configuration is:

```json
{
  "model": "gpt-6-astra",
  "reasoning": { "mode": "pro", "effort": "xhigh" },
  "background": true,
  "store": true
}
```

Pro is `reasoning.mode`, independent of `reasoning.effort`; use the model ID `gpt-6-astra`. Astra supports `low`, `medium`, `high`, `xhigh`, and `max` effort. Keep `xhigh` for the default expert consult; use `--reasoning max` when the task calls for more reasoning. `--reasoning-mode standard` opts out of Pro. Pro uses more model work and tokens, with higher latency and cost. Astra does not support `none`, `minimal`, `temperature`, `top_p`, or `top_logprobs`.

Verified against the official [Astra model page](https://developers.openai.com/api/docs/models/gpt-6-astra), [migration guide](https://developers.openai.com/api/docs/guides/latest-model), and [reasoning mode documentation](https://developers.openai.com/api/docs/guides/reasoning#reasoning-mode) on 2026-09-04. If the API reports that Astra is unavailable to the account, report that error; preserve the requested model unless the user chooses an alternative.

## Consultation Workflow

1. Decide whether an external consult is appropriate.
   - Use for hard debugging, architecture choices, security-sensitive code review, tricky API integration, migration plans, or test design.
   - Do not use when the user forbids external API calls, when the task is trivial, or when sensitive secrets would need to be sent.

2. Gather focused context.
   - Attach only files needed to answer the question.
   - Prefer several exact files plus focused globs over one broad repository glob.
   - Repeat `--file` for multiple files and globs; use `--dir` for directories when the relevant surface is broad.
   - Exclude generated output, vendored dependencies, large artifacts, and secrets.

3. Write a concrete prompt.
   - Include the goal, constraints, known symptoms, what has already been tried, and the desired output shape.
   - Ask for actionable findings, risks, and concrete next steps.
   - For review requests, ask for prioritized bugs and missing tests before summary.
   - This is a single consultation without local tools or interactive clarification. Ask for the best supported answer from the supplied context, stated assumptions, and specific missing evidence; avoid prompts that require executing commands or waiting for a reply.

4. Run a dry run for broad context and check the token estimate.

```sh
expert ask "Check whether this refactor is safe." --file package.json --file "src/**/*.ts" --file "test/**/*.ts" --dry-run --format json
```

Check `model`, `reasoning_mode`, `reasoning_effort`, and `estimated_input_tokens` in the output before sending. Trim the attachment list if it approaches the model's capacity (see Context Budget below).

5. Run the consult and wait for the answer.

```sh
expert ask "Find correctness risks in this change. Return prioritized findings with file references." \
  --file package.json \
  --file "src/**/*.ts" \
  --file "test/**/*.ts" \
  --exclude "dist/**"
```

## Command Patterns

Use stdin for long prompts or generated context:

```sh
git diff -- src test | expert ask "Review this diff for regressions and missing tests." --stdin --file package.json
```

Use JSON when another tool or script will consume the answer:

```sh
expert ask "Summarize API compatibility risks as JSON." --file src/api.ts --format json
```

Resume after interruption or timeout:

```sh
expert resume <job_id>
expert status <job_id>
expert cancel <job_id>
```

Tune blocking behavior only when needed (`--timeout` accepts `s`/`m`/`h`, default `360m`):

```sh
expert ask "Deeply analyze this flaky test." --file test/flaky.test.ts --timeout 12h --poll-interval 5s
```

## Context Budget

GPT-6 Astra has a 1,050,000-token context window shared by input, reasoning, and output (128,000 max output tokens). Do not exceed it:

- The CLI estimates input size (~4 characters per token) and refuses to send when the estimate exceeds 900,000 tokens. Prefer trimming the attachment list over raising `--max-context-tokens`.
- Requests whose input exceeds 272,000 tokens are billed by OpenAI at 2x input / 1.5x output for the entire request. Stay below that unless the extra context clearly earns its cost; the CLI warns when a consult crosses it.
- Byte-based estimates are unreliable for PDFs and other rich formats; leave extra headroom when attaching them.
- `--max-output-tokens` caps reasoning and visible output together; a small cap can exhaust the budget before an answer is produced.
- When context is too large, split the question into multiple focused consults instead of one oversized one, and summarize earlier answers in follow-up prompts.

## Context Selection Guidance

- Include entrypoints, changed files, nearby tests, relevant configs, schemas, docs, and error logs.
- Include `package.json`, lockfiles, or build configs when dependency or tooling behavior matters.
- Include the failing command and concise output in the prompt or stdin.
- Avoid attaching `.env`, credentials, private keys, customer data, build directories, `node_modules`, and unrelated repository snapshots.
- For large repos, start with a dry run and narrow the attachment list before sending.

## Interpreting Results

- Treat the consult as expert input, not automatic truth.
- Verify concrete claims against the local repo before editing.
- If the answer is incomplete or asks for more context, rerun `expert ask` with the missing files and summarize the previous response in the new prompt.
- If the terminal is interrupted, preserve the printed `expert resume <job_id>` command.
- If the consult exits with code 124, local polling timed out but the job is still running server-side; run the printed `expert resume <job_id>` command (add `--timeout 12h` to wait longer). Under `--format json`, a timeout emits the envelope with `timed_out: true`.

## Defaults

The CLI defaults to `gpt-6-astra` with `reasoning.effort: xhigh`, `background: true`, `store: true`, a 360 minute (6 hour) timeout, a 5 second polling interval, and a 900,000-token estimated-input cap (`--max-context-tokens`). `reasoning.mode` defaults to `pro` for GPT-6 Astra and GPT-5.6 models and `standard` for anything else. It requires `OPENAI_API_KEY`; job records are stored under `~/.expert/jobs` unless `EXPERT_HOME` is set.
