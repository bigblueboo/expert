# expert

`expert` is a TypeScript CLI for asking GPT-5.6 Pro for a long-running consultation with explicit local context. It uses the OpenAI Responses API in background mode, stores a local job record, polls until completion, and supports resume/status/cancel.

## Local setup

```sh
npm install
npm run build
export OPENAI_API_KEY=...
```

Run the local build with `node dist/cli.js`.

## Global install

The CLI and the Codex skill are installed separately.

Install the CLI globally from this repo:

```sh
npm install -g .
```

After the package is published, install it from npm instead:

```sh
npm install -g expert
```

Install the Codex skill globally from GitHub:

```sh
python3 ~/.codex/skills/.system/skill-installer/scripts/install-skill-from-github.py \
  --repo bigblueboo/expert \
  --path skills/expert
```

Or, if you've cloned this repo locally, install the skill from the checkout:

```sh
./scripts/install-skill.sh
```

Pass `--force` to replace an already-installed copy of the skill.

Restart Codex after installing the skill. The skill is installed into `${CODEX_HOME:-~/.codex}/skills/expert`.

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
- a 60 minute polling timeout
- a 5 second polling interval

Interrupted jobs keep running server-side. Resume with the command printed on interrupt:

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

## Context selection notes

- `--exclude` patterns use gitignore syntax, not plain globs. Safety defaults (`.env`, `*.pem`, `node_modules/`, …) and your `--exclude` patterns are applied unconditionally; a `.gitignore` negation (`!file`) cannot re-include them.
- Symbolic links are never followed; they are reported in the skipped-files list.
- An explicitly named `--file` that does not exist is an error. Glob patterns that match nothing are reported as skipped.
- `-o/--output` writes the rendered result (the full JSON envelope under `--format json`) to the file and still prints it to stdout.

## Data handling

- Attached files are uploaded to the OpenAI Files API with `purpose: "user_data"`, and responses are created with `store: true`. Uploaded files and stored responses persist in your OpenAI account until deleted there; the CLI only deletes uploads when a later upload in the same batch fails.
- `OPENAI_BASE_URL` redirects all traffic — including your API key and uploaded file content — to the given host. It exists for testing against mock servers; treat it as security-sensitive.

## Skill layout

This repo includes the global-installable skill at:

```text
skills/expert/
├── SKILL.md
└── agents/
    └── openai.yaml
```

The skill teaches Codex when and how to use the `expert` CLI for GPT-5.6 Pro second opinions. It assumes the `expert` CLI is available on `PATH` and `OPENAI_API_KEY` is configured.
