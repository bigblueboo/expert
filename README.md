# expert

[![CI](https://github.com/bigblueboo/expert/actions/workflows/ci.yml/badge.svg)](https://github.com/bigblueboo/expert/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40bigblueboo%2Fexpert)](https://www.npmjs.com/package/@bigblueboo/expert)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

`expert` asks GPT-5.6 Pro for a second opinion, with real files from your repo attached. You name the files; it uploads them, starts a background job on the OpenAI Responses API, and polls until the answer comes back. Pro consults can take a while — the default timeout is 6 hours (`--timeout` to change it). Every consult gets a local job record, so if your terminal dies mid-wait you can pick the job back up with `expert resume`.

The repo also includes two agent skills. [expert](skills/expert/SKILL.md) teaches Claude Code, Codex, and other coding agents when to reach for the CLI. [thermo-nuclear-expert-review](skills/thermo-nuclear-expert-review/SKILL.md) uses it for an ultra-strict structural code review: the diff, a demanding review charter, and as much of your repo as the token budget allows all go to GPT-5.6 Pro together. Its standards are adapted from the Cursor team's thermo-nuclear-code-quality-review skill.

If you know [Oracle](https://github.com/steipete/oracle), this covers similar ground. Oracle can drive ChatGPT Pro through a browser session so subscribers don't need an API key; `expert` stays on the API. One engine, fewer moving parts.

## Quick start

Requires Node >= 20 and an `OPENAI_API_KEY`:

```sh
export OPENAI_API_KEY=...
npx -y @bigblueboo/expert ask "Review this implementation plan" --file README.md
```

## Install

### Agent skills

Install the skills with the [skills CLI](https://github.com/vercel-labs/skills):

```sh
npx skills add bigblueboo/expert
```

It discovers the skills in this repo's `skills/` directory and installs the ones you pick. The skills call the CLI through `npx -y @bigblueboo/expert`; there's nothing else to install. Set `OPENAI_API_KEY` wherever your agent runs, and restart the agent to pick up the skills.

### CLI only

```sh
npm install -g @bigblueboo/expert
```

### From a checkout

```sh
npm install               # installs deps and builds dist/ via the prepare script
npm install -g .          # optional: put `expert` on PATH
./scripts/install-skill.sh
```

`install-skill.sh` installs every skill in `skills/` (or just the ones you name as arguments) into `${AGENTS_HOME:-~/.agents}/skills` and symlinks the `~/.claude/skills` and `${CODEX_HOME:-~/.codex}/skills` entries to those copies, so all tools share one copy per skill. It validates every destination before changing anything; pass `--force` to replace existing installs.

## Usage

```sh
expert ask "Review this implementation plan" --file README.md
expert ask "Inspect these files" --dir src --exclude "src/**/*.test.ts"
expert ask "Use stdin too" --stdin --file package.json < notes.md
expert ask "Review mixed context" --file README.md --file "src/**/*.ts" --file "test/**/*.ts"
```

By default `ask` uses:

- `model: gpt-5.6`
- `reasoning.mode: pro` for GPT-5.6 models, `standard` otherwise (override with `--reasoning-mode`)
- `reasoning.effort: xhigh`
- `background: true`
- `store: true`
- a 6 hour polling timeout (`--timeout` takes `s`/`m`/`h`, e.g. `--timeout 12h` or `--timeout 30m`)
- a 5 second polling interval
- a 900,000-token cap on estimated input (`--max-context-tokens`)

A timeout or Ctrl-C only stops the local polling. The job itself keeps running on OpenAI's side. When the timeout elapses, the CLI exits with code 124, marks the local job record `timeout`, and prints the last known status plus the exact `expert resume` command to run — add a bigger `--timeout` if six hours wasn't enough. Under `--format json` a timeout also writes the response envelope to stdout with `timed_out: true`, `timeout_ms`, and `waited_ms`, so a script can tell an aborted wait from an answer.

```sh
expert resume <job_id>
expert status <job_id>
expert cancel <job_id>
```

Use `--dry-run --format json` to inspect the resolved context before spending tokens:

```sh
expert ask "Check context" --file package.json --file "src/**/*.ts" --file "test/**/*.ts" --dry-run --format json
```

Job records are stored under `~/.expert/jobs` unless `EXPERT_HOME` is set. Records contain the full prompt and context manifest and are written with `0600` permissions.

## The review skill

The second skill, `thermo-nuclear-expert-review`, never fires on its own — its frontmatter sets `disable-model-invocation`, and your agent runs it only when you ask by name ("run a thermo-nuclear review of this branch").

It diffs your branch against the default branch, uncommitted and untracked work included, then assembles the largest repo snapshot the token budget allows. Changed files go in whole, along with their tests, the files that import them, each package's shared utility modules, and the configs that define your conventions. Small coherent repos send the whole source tree. A bundled script builds the request and budget-checks the exact consult it will send, stopping at the 272,000-token surcharge line unless told the context earns it. Everything reaches GPT-5.6 Pro in one consult — the charter and diff on stdin, the sources as attachments — with at most one follow-up if the reviewer names files it was missing.

The charter (`skills/thermo-nuclear-expert-review/charter.md`) sets the standards. The verdict comes back as `APPROVE`, `NEEDS RESTRUCTURING`, or `INSUFFICIENT CONTEXT`, with each finding tied to the code it concerns and marked `BLOCKER` or `RECOMMENDED`. Some things are presumptive blockers: pushing a file past 1,000 lines, duplicating a helper that already has a canonical home, adding branching that tangles an existing flow. Before relaying the review, the agent is instructed to check every claim against the repo and drop findings that don't hold up.

Expect a consult like this to spend real tokens and real time. Attaching half the repo and waiting on a Pro-grade answer is the point.

## Context budget

GPT-5.6 has a 1,050,000-token context window shared by input, reasoning, and output (128,000 max output tokens). The CLI estimates input at ~4 characters per token and refuses to send when the estimate exceeds `--max-context-tokens`. The default cap is 900,000; the rest of the window is headroom for reasoning and output. Dry runs report `estimated_input_tokens` (and per-file `estimated_tokens` under `--format json`) instead of failing. Use them to trim an oversized attachment list.

Requests whose input exceeds 272,000 tokens are billed by OpenAI at 2x input / 1.5x output for the entire request; the CLI warns before sending one. The ~4-chars-per-token estimate is also unreliable for PDFs and other rich formats. Leave extra headroom when attaching them.

## Context selection notes

- `--exclude` patterns use gitignore syntax, not plain globs. Safety defaults (`.env`, `*.pem`, `node_modules/`, …) and your `--exclude` patterns are applied unconditionally; a `.gitignore` negation (`!file`) cannot re-include them.
- Symbolic links are never followed; they are reported in the skipped-files list.
- An explicitly named `--file` that does not exist is an error. Glob patterns that match nothing are reported as skipped.
- `-o/--output` writes the rendered result (the full JSON envelope under `--format json`) to the file and still prints it to stdout.

## Data handling

Attached files are uploaded to the OpenAI Files API with `purpose: "user_data"`, and responses are created with `store: true`. Uploaded files and stored responses stay in your OpenAI account until you delete them there; the CLI only deletes uploads when a later upload in the same batch fails.

`OPENAI_BASE_URL` redirects all traffic — including your API key and uploaded file content — to the given host. It exists for testing against mock servers. Treat it as security-sensitive.

## Skill layout

```text
skills/
├── expert/
│   ├── SKILL.md
│   └── agents/
│       └── openai.yaml
└── thermo-nuclear-expert-review/
    ├── SKILL.md
    ├── charter.md          # the review standards, piped to the model
    ├── scripts/
    │   └── run-review.sh   # builds the diff+prompt, budget-checks, runs the consult
    └── agents/
        └── openai.yaml
```

Both skills prefer an `expert` binary on `PATH` and fall back to `npx -y @bigblueboo/expert`. Either way `OPENAI_API_KEY` has to be set.

## Development

```sh
npm install    # installs deps and builds via the prepare script
npm test       # builds and runs the vitest suite (mock OpenAI server; no API key needed)
npm run dev -- ask "Check context" --file package.json --dry-run
```

## License

[MIT](LICENSE)
