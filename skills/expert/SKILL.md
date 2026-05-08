---
name: expert
description: Consult GPT-5.5 Pro through the local `expert` CLI for second opinions on coding tasks. Use when Codex needs a high-quality external review, architecture/debugging help, test strategy feedback, implementation plan critique, or analysis of attached code/docs using explicit local files, directories, globs, or stdin. Especially useful for hard, ambiguous, high-risk, or long-running coding questions where blocking up to 60 minutes is acceptable.
---

# Expert

Use the `expert` CLI to ask GPT-5.5 Pro for a second opinion with explicit local context. The CLI uploads named files, starts a background Responses API job, polls until completion, and stores a resumable job record.

## Quick Start

Prefer the installed binary when available:

```sh
expert ask "Review this implementation for correctness and missing tests." --file src/foo.ts --file test/foo.test.ts
```

If working inside this repository and `expert` is not on `PATH`, use the built CLI:

```sh
npm run build
node dist/cli.js ask "Review this implementation for correctness and missing tests." --file src/foo.ts --file test/foo.test.ts
```

## Consultation Workflow

1. Decide whether an external consult is appropriate.
   - Use for hard debugging, architecture choices, security-sensitive code review, tricky API integration, migration plans, or test design.
   - Do not use when the user forbids external API calls, when the task is trivial, or when sensitive secrets would need to be sent.

2. Gather focused context.
   - Attach only files needed to answer the question.
   - Prefer several exact files plus focused globs over one broad repository glob.
   - Repeat `--file` for multiple files and globs; use directories when the relevant surface is broad.
   - Exclude generated output, vendored dependencies, large artifacts, and secrets.

3. Write a concrete prompt.
   - Include the goal, constraints, known symptoms, what has already been tried, and the desired output shape.
   - Ask for actionable findings, risks, and concrete next steps.
   - For review requests, ask for prioritized bugs and missing tests before summary.

4. Run a dry run for broad context.

```sh
expert ask "Check whether this refactor is safe." --file package.json --file "src/**/*.ts" --file "test/**/*.ts" --dry-run --format json
```

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

Tune blocking behavior only when needed:

```sh
expert ask "Deeply analyze this flaky test." --file test/flaky.test.ts --timeout 60m --poll-interval 5s
```

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

## Defaults

The CLI defaults to `gpt-5.5-pro`, `reasoning.effort: xhigh`, `background: true`, `store: true`, a 60 minute timeout, and a 5 second polling interval. It requires `OPENAI_API_KEY`; job records are stored under `~/.expert/jobs` unless `EXPERT_HOME` is set.
