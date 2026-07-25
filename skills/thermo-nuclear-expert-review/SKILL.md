---
name: thermo-nuclear-expert-review
description: Run a thermo-nuclear code quality review through GPT-5.6 Pro via the `expert` CLI - an extremely strict structural maintainability audit of a branch or diff, with as much of the repository attached as the token budget allows. Use when asked for a thermo-nuclear review, a thermonuclear review, an expert deep code quality audit, or an especially harsh external review of maintainability, abstraction quality, and spaghetti growth.
disable-model-invocation: true
---

# Thermo-Nuclear Expert Review

Delegate an ultra-strict structural code review to GPT-5.6 Pro through the `expert`
CLI. The review standards live in `charter.md`, which sits next to this SKILL.md; the
charter is piped to the model along with the diff, and the repository sources are
attached as files. Your job is to assemble the richest context the budget allows, run
one high-quality consult, verify what comes back, and deliver the verdict.

The charter demands judgments a bare diff cannot support — "reuse the canonical
helper", "is this logic in the right layer", "is there a code-judo move that deletes
this complexity". Those calls require seeing the code *around* the change. Attaching
generous context is the whole point of running this review through `expert`; when in
doubt, attach more.

Requires `OPENAI_API_KEY`. Prefer `expert` on `PATH`; otherwise use
`npx -y @bigblueboo/expert`. The consult spends real tokens and can block for a long
time (default timeout 6 hours) — that is expected and acceptable for this review.

## Step 1 — Pin down the diff under review

Default to the current branch's full delta against the default branch, including
uncommitted work:

```sh
base=$(git merge-base HEAD origin/main)   # or origin/master
git diff "$base" --stat                   # sanity-check the scope
git diff "$base" --name-only              # the changed-file list, used below
```

If the user asked to review something narrower (staged changes, one commit, a PR),
substitute the appropriate diff and keep the rest of the workflow the same.

## Step 2 — Assemble maximal context

Build the attachment list in this priority order:

1. Full current contents of every changed file (not just the diff hunks).
2. The tests for those files.
3. First-degree neighbors: files that import the changed files or are imported by
   them. Find importers with `grep -rl` on the changed modules' names.
4. The shared/canonical utility modules of every package the diff touches — the
   charter requires citing canonical helpers, so the model has to see them.
5. Manifests and configs that define conventions: `package.json`, `tsconfig.json`,
   lockfile excerpts, lint configs, or their equivalents.

Then try to do better than the priority list: attach the whole source tree if it
fits. Run a dry run to measure:

```sh
expert ask "budget check" --dir src --dir test --file package.json \
  --exclude "dist/**" --exclude "**/*.snap" --dry-run --format json
```

Read `estimated_input_tokens` from the output:

- **Under 272,000**: attach the whole tree. Full-repo visibility materially improves
  this review and costs nothing extra.
- **Over 272,000**: OpenAI bills the entire request at 2x input / 1.5x output past
  that line. Cross it only when the repo-wide context genuinely earns the surcharge
  (large diff, heavy cross-package coupling); otherwise trim back to the priority
  list above, dropping from the bottom.
- **Near the 900,000 cap**: the CLI refuses to send. Trim until the dry run fits,
  splitting the review by package or subsystem if a single consult cannot hold it.

Never attach secrets, vendored dependencies, build output, or generated artifacts.
The CLI's safety excludes handle the obvious cases; add `--exclude` for the rest.

## Step 3 — Run the consult

Pipe the charter and the diff through stdin; attach the sources as files. With
`$SKILL_DIR` as the directory containing this SKILL.md:

```sh
{
  cat "$SKILL_DIR/charter.md"
  echo
  echo "=== DIFF UNDER REVIEW (merge-base -> working tree) ==="
  git diff "$base"
} | expert ask "Perform the thermo-nuclear code quality review defined by the charter in stdin. The diff under review follows the charter in stdin. The attached files are full current sources for structural context. Follow the charter's Output Contract exactly." \
  --stdin \
  --dir src --dir test \
  --file package.json \
  --exclude "dist/**"
```

Adjust `--dir`/`--file`/`--exclude` to match the attachment list from Step 2. Add
`-o review.md` if the user wants the raw review kept. If the consult is interrupted,
run the `expert resume <job_id>` command it prints; if it exits with code 124, the
job is still running — resume it, with a larger `--timeout` if needed.

If the verdict is `INSUFFICIENT CONTEXT`, attach exactly the files it names, prepend
a one-paragraph summary of the first round to the prompt, and consult again.

## Step 4 — Verify, then deliver

The review is expert input, not automatic truth. Before relaying or acting on it:

- Verify every structural claim against the repo: cited helpers exist, cited
  file:line references are real, a proposed code-judo reframe actually preserves
  behavior given code the model may not have seen.
- Drop findings that do not survive verification, and say you dropped them.
- Keep the charter's priority order and the `BLOCKER` / `RECOMMENDED` marks.
- Lead with the verdict. If it is `NEEDS RESTRUCTURING`, present the blockers as the
  work list; do not soften them into optional suggestions.
- Only start implementing remedies if the user asked for fixes, not just the review.

---

Review standards adapted from the Cursor team's `thermo-nuclear-code-quality-review`
skill, restructured as a charter for an external GPT-5.6 Pro consultation.
