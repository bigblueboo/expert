---
name: thermo-nuclear-expert-review
description: Run a thermo-nuclear code quality review through GPT-5.6 Pro via the `expert` CLI - an extremely strict structural maintainability audit of a branch or diff, with as much of the repository attached as the token budget allows. Use when asked for a thermo-nuclear review, a thermonuclear review, an expert deep code quality audit, or an especially harsh external review of maintainability, abstraction quality, and spaghetti growth.
disable-model-invocation: true
---

# Thermo-Nuclear Expert Review

Delegate an ultra-strict structural code review to GPT-5.6 Pro through the `expert`
CLI. The review standards live in `charter.md` next to this SKILL.md, and the whole
consult runs through the bundled `scripts/run-review.sh`, which pins the diff
(tracked *and* untracked files), builds the charter+diff prompt, budget-checks the
exact request with a dry run, and only then spends tokens. Your job is to choose the
extra context, run the script, verify what comes back, and deliver the verdict.

The charter demands judgments a bare diff cannot support — "reuse the canonical
helper", "is this logic in the right layer", "is there a code-judo move that deletes
this complexity". Those calls require seeing the code *around* the change, so attach
generous context; when in doubt, attach more.

## Before you run it

- Needs `OPENAI_API_KEY`. The script prefers `expert` on `PATH` and falls back to
  `npx -y @bigblueboo/expert` on its own.
- The consult spends real tokens and can block for hours (default timeout 6h). That
  is expected for this review.
- Everything attached is uploaded to the OpenAI Files API and stored in that OpenAI
  account until deleted there. Do not run this when the user forbids external API
  calls, and never attach secrets or customer data. If `OPENAI_BASE_URL` is set to
  something unexpected, stop and ask — it redirects the key and all uploads.

## Step 1 — Pin the scope

By default the script reviews the working tree against the merge-base with the
repository's default branch, untracked files included. Pass `--base <ref>` to diff
against something else.

The script always reviews the working tree as it stands. To review a single commit,
staged-only changes, or a PR head, check that state out cleanly first — reviewing a
dirty tree against a narrower target would attach code the diff does not contain.

## Step 2 — Choose the extra context

Changed files are always attached in full, and the prompt carries the diffstat and
per-file line counts the charter's 1000-line rule needs. Beyond that, pass
`--attach` (repeatable; files, globs, or directories) in this priority order:

1. The tests for the changed files.
2. First-degree neighbors: files that import the changed files or are imported by
   them. Find importers with `grep -rl` on the changed modules' names.
3. The shared/canonical utility modules of every package the diff touches — the
   charter requires citing canonical helpers, so the model has to see them.
4. Manifests and configs that define conventions: `package.json`, `tsconfig.json`,
   lint configs, or their equivalents.
5. If the source tree is small and coherent, the whole tree — full-repo visibility
   is what lets the reviewer catch wrong-layer and duplicate-helper problems. It
   still bills every input token; what staying under 272,000 tokens avoids is the
   2x input / 1.5x output long-context multiplier, which the script enforces.

Check the budget with the script's dry run, which measures the exact final request
(charter, diff, and all attachments included):

```sh
"$SKILL_DIR"/scripts/run-review.sh --attach "src/**/*.ts" --attach package.json --dry-run
```

`$SKILL_DIR` here means the directory containing this SKILL.md — substitute the
real path. If the estimate crosses 272k, the script stops; rerun with `--yes` only
when the extra context genuinely earns the surcharge (large diff, heavy
cross-package coupling). If it exceeds the 900k cap, trim `--attach` entries or
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

The script aborts before spending anything if the charter, diff, or budget check
fails. If the consult is interrupted, run the `expert resume <job_id>` command it
prints; exit code 124 means local polling timed out while the job kept running —
resume it, with a larger `--timeout` if needed.

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
skill, restructured as a charter for an external GPT-5.6 Pro consultation.
