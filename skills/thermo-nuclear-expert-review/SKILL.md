---
name: thermo-nuclear-expert-review
description: Run a thermo-nuclear code quality review with the heaviest reviewer available - GPT-6 Astra in Pro mode over the API, GPT-6 Astra through the local `codex` CLI, or Claude Fable through the local `claude` CLI, the last two read-only in the repo under their own logins. An extremely strict structural maintainability audit of a branch or diff, with as much of the repository in view as the token budget allows. Use when asked for a thermo-nuclear review, a thermonuclear review, an expert deep code quality audit, or an especially harsh external review of maintainability, abstraction quality, and spaghetti growth.
disable-model-invocation: true
---

# Thermo-Nuclear Expert Review

Delegate an ultra-strict structural code review to an external model. The review
standards live in `charter.md` next to this SKILL.md, and the whole consult runs
through the bundled `scripts/run-review.sh`, which pins the diff (tracked *and*
untracked files), builds the charter+diff prompt, resolves the context files and
budget-checks the exact request with a dry run, and only then spends tokens. Your
job is to choose the engine and the extra context, run the script, verify what comes
back, and deliver the verdict.

The charter demands judgments a bare diff cannot support — "reuse the canonical
helper", "is this logic in the right layer", "is there a code-judo move that deletes
this complexity". Those calls require seeing the code *around* the change, so attach
generous context; when in doubt, attach more.

## Choose the engine

Pick the reviewer the user names; they will usually say a model, not an engine.

| Reviewer | Command | Runs through | Login |
|---|---|---|---|
| GPT-6 Astra Pro | `--engine expert` (default) | OpenAI API, Pro reasoning mode | `EXPERT_OPENAI_API_KEY` |
| GPT-6 Astra | `--engine codex` | local `codex` CLI, read-only sandbox | Codex's own (ChatGPT plan or API key) |
| Claude Fable | `--engine claude` | local `claude` CLI, read-only tools | Claude Code's own (Claude plan or API key) |

With no preference stated, use `expert` when `EXPERT_OPENAI_API_KEY` is set, and
otherwise `codex` or `claude`, whichever is installed and logged in. Every engine
defaults to `xhigh` effort; pass `--effort max` for a heavier pass, or `--model` to
pick another model the engine supports (`--codex-model` and `--codex-effort` still
work as aliases).

- **`expert`** sees exactly what the script sends: the diff inline and the context
  files uploaded. Billed per token to the key's account.
- **`codex`** and **`claude`** are agents running inside the repository. They get
  the diff as a file path and the context as a JSON manifest of paths, must read
  all of it in full, and may read further on their own. Codex can also run
  read-only commands; Claude has only Read, Grep, and Glob. For `gpt-6-astra` the
  script lifts Codex's own 272k cap on that model to the full 1.05M API window.

## Before you run it

- Every engine needs Node and the `expert` CLI, which resolves the context files
  and runs the dry run. The script prefers `expert` on `PATH` and falls back to
  `npx -y @bigblueboo/expert` on its own. Run the script from the repository root.
- `expert` needs `EXPERT_OPENAI_API_KEY`; the script stops if it is unset and never
  reads `OPENAI_API_KEY`. It selects `reasoning.mode: pro` explicitly, including
  for its dry run.
- `codex` needs `codex` on `PATH` and a working `codex login`. The script ignores the
  user's Codex config, so MCP servers and connectors never load. It turns off apps,
  plugins, browser and computer use, web search, and image generation, sets
  approvals to `never`, and does not load the repo's `AGENTS.md`, since that file is
  evidence under review. A `--dry-run` checks only that `codex` is installed and
  logged in; `codex exec` validates the lockdown at launch and rejects unknown
  flags, feature names, and settings before sending anything, so a Codex that has
  renamed one fails the run instead of running looser.
- `claude` needs Claude Code on `PATH`; a `--dry-run` checks `claude auth status`.
  It runs `claude -p` with only Read, Grep, and Glob, in `dontAsk` mode so
  anything not pre-approved is denied, with no settings files (neither the user's
  hooks nor the repo's `.claude/`) and no MCP servers. Reads of the secret files
  below are denied outright.
- `EXPERT_OPENAI_API_KEY` is removed from both agents' environments.
- Any consult spends real tokens or plan quota and can block for hours (the
  `expert` default timeout is 6h). That is expected for this review.
- Every engine sends code to its provider: OpenAI for `expert` and `codex`,
  Anthropic for `claude`. The script treats `.env`, `.env.*`, `*.pem`, `*.key`,
  `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, `.npmrc`, and `.netrc` as secrets
  for every engine. Any changed file the context resolver would not attach (an
  `--exclude` match, a secret, a binary, a symlink, an oversized file) is withheld from the diff and the
  manifest too, and the prompt lists it as withheld. Deleted files are not
  checked, so a deleted secret still shows in the diff. `expert` uploads attachments to the
  OpenAI Files API, stored in that account until deleted there. The agents send
  whatever they read; Codex is told never to open secrets but nothing enforces it,
  so do not use `codex` in a tree where a secret on disk must never leave the
  machine. Do not run any engine when the user forbids external API calls. If
  `OPENAI_BASE_URL` is set to something unexpected, stop and ask — it redirects the
  expert key and all uploads.

## Step 1 — Pin the scope

By default the script reviews the working tree against the merge-base with the
repository's default branch, untracked files included. Pass `--base <ref>` to diff
against something else.

The script always reviews the working tree as it stands. To review a single commit,
staged-only changes, or a PR head, check that state out cleanly first — reviewing a
dirty tree against a narrower target would attach code the diff does not contain.

## Step 2 — Choose the extra context

Changed files are always included in full, and the prompt carries the diffstat and
per-file line counts the charter's 1000-line rule needs. Beyond that, pass
`--attach` (repeatable; files, globs, or directories) in this priority order. The
same list serves every engine: `expert` uploads it, and the agents get it as a
manifest they must read in full before judging. Add `--exclude` for lockfiles and
generated files; it keeps them out of the diff too.

1. The tests for the changed files.
2. First-degree neighbors: files that import the changed files or are imported by
   them. Find importers with `grep -rl` on the changed modules' names.
3. The shared/canonical utility modules of every package the diff touches — the
   charter requires citing canonical helpers, so the model has to see them.
4. Manifests and configs that define conventions: `package.json`, `tsconfig.json`,
   lint configs, or their equivalents.
5. If the source tree is small and coherent, the whole tree — full-repo visibility
   is what lets the reviewer catch wrong-layer and duplicate-helper problems. With
   `expert` it still bills every input token; what staying under 272,000 tokens
   avoids is the 2x input / 1.5x output long-context multiplier, which the script
   enforces.

Check the budget with the script's dry run, which measures the exact final request
(charter, diff, and all attachments included). It prints the estimate on stderr;
on stdout it prints the CLI's JSON report with per-file estimates for `expert`, or
the exact JSON manifest the agent will get for `codex` and `claude`:

```sh
"$SKILL_DIR"/scripts/run-review.sh --attach "src/**/*.ts" --attach package.json --dry-run
```

`$SKILL_DIR` here means the directory containing this SKILL.md — substitute the
real path. With `expert`, if the estimate crosses 272k the script stops; rerun with
`--yes` only when the extra context genuinely earns the surcharge (large diff, heavy
cross-package coupling). The agents have no surcharge; for `codex` the script warns
when the estimate will not fit in one window (~800k for Astra, ~400k otherwise) and
Codex would compact as it reads, so trim instead of letting it. For every engine,
if the estimate exceeds the 900k cap, trim `--attach` entries or
split the review by subsystem — and if you split, either deliver per-subsystem
verdicts labeled as such or run a final synthesis consult over the combined
findings; do not merge them into one global verdict by hand.

The script excludes `**/dist/**`, `**/build/**`, `**/coverage/**`, and
`**/node_modules/**` everywhere in the tree; add `--exclude` for other generated
artifacts. Never attach secrets — the CLI's safety excludes cover the obvious
cases.

## Step 3 — Run the consult

```sh
"$SKILL_DIR"/scripts/run-review.sh \
  --attach "src/**/*.ts" --attach "test/**/*.ts" --attach package.json \
  --output review.md
```

Add `--engine codex` or `--engine claude` to run the same review through an agent.

The script aborts before spending anything if the charter, diff, or budget check
fails. If an `expert` consult is interrupted, run the `expert resume <job_id>`
command it prints; exit code 124 means local polling timed out while the job kept
running — resume it, with a larger `--timeout` if needed. A `codex` or `claude`
consult runs in the foreground with no job to resume; if it is interrupted, rerun
the script.

If the verdict is `INSUFFICIENT CONTEXT`: write a short summary of round one to a
file, then rerun the script once with `--note <that-file>` plus `--attach` for
exactly the files the reviewer named. The script resends the full charter and the
same diff automatically — a second consult shares no state with the first, so
nothing may be abbreviated. One retry only; if context is still insufficient,
deliver the scoped verdict and name the unresolved gaps.

## Step 4 — Verify, then deliver

The review is expert input, not automatic truth. Before relaying or acting on it:

- Verify every finding against the repo: cited helpers exist, cited code references
  are real, a proposed code-judo reframe actually preserves behavior given code the
  model may not have seen. Run the typecheck or tests when a claim depends on
  behavior being preserved; if you cannot check it, label the claim unverified
  rather than dropping or endorsing it.
- Drop findings that fail verification, and say you dropped them.
- Then recompute the verdict from the surviving findings under the charter's own
  rules. Report both: the reviewer's raw verdict and your verified verdict. A
  `NEEDS RESTRUCTURING` built on a disproven blocker becomes an `APPROVE`; say so
  plainly.
- Keep the charter's priority order and the `BLOCKER` / `RECOMMENDED` marks, and
  relay the reviewer's scope-and-gaps section with the verdict.
- Only start implementing remedies if the user asked for fixes, not just the review.

---

Review standards adapted from the Cursor team's `thermo-nuclear-code-quality-review`
skill, restructured as a charter for an external consultation with GPT-6 Astra in Pro mode.
