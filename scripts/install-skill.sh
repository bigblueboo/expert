#!/usr/bin/env bash
# Install skills from this checkout's skills/ directory into
# ${AGENTS_HOME:-~/.agents}/skills, then symlink the Claude (~/.claude/skills)
# and Codex (${CODEX_HOME:-~/.codex}/skills) entries to those canonical copies.
#
# All destinations are validated before anything is modified, so a conflict
# cannot leave a half-installed set.
set -euo pipefail

usage() {
  echo "Usage: $(basename "$0") [--force] [skill-name...]" >&2
  echo "  Installs the named skills, or every skill under skills/ by default." >&2
  echo "  --force  Replace existing installed skills." >&2
}

fail() { echo "install-skill: $*" >&2; exit 1; }

force=0
requested=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -f|--force) force=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) usage; exit 2 ;;
    *) requested+=("$1"); shift ;;
  esac
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
canonical_root="${AGENTS_HOME:-$HOME/.agents}/skills"
claude_root="$HOME/.claude/skills"
codex_root="${CODEX_HOME:-$HOME/.codex}/skills"

case "$canonical_root" in /*) ;; *) fail "AGENTS_HOME must be an absolute path" ;; esac
case "$codex_root" in /*) ;; *) fail "CODEX_HOME must be an absolute path" ;; esac

# Collect the skills to install.
sources=()
for src in "$repo_root"/skills/*/; do
  src="${src%/}"
  [[ -f "$src/SKILL.md" ]] || continue
  if [[ ${#requested[@]} -gt 0 ]]; then
    wanted=0
    for name in "${requested[@]}"; do
      [[ "$(basename "$src")" == "$name" ]] && wanted=1
    done
    [[ "$wanted" -eq 1 ]] || continue
  fi
  sources+=("$src")
done
count=${#sources[@]}
if [[ "$count" -eq 0 ]]; then
  fail "no matching skills under $repo_root/skills"
fi
if [[ ${#requested[@]} -gt 0 && "$count" -ne ${#requested[@]} ]]; then
  fail "some requested skills were not found under $repo_root/skills"
fi

# Preflight every destination before touching anything.
conflicts=()
for src in "${sources[@]}"; do
  name="$(basename "$src")"
  canonical="$canonical_root/$name"

  case "$canonical/" in "$src"/*) fail "canonical destination $canonical overlaps the checkout source $src" ;; esac
  case "$src/" in "$canonical"/*) fail "checkout source $src overlaps the canonical destination $canonical" ;; esac

  for dest in "$canonical" "$claude_root/$name" "$codex_root/$name"; do
    # A link path identical to the canonical path (e.g. AGENTS_HOME=~/.claude)
    # is skipped at install time, so it is not a conflict.
    [[ "$dest" != "$canonical" && "$dest" -ef "$canonical" ]] 2>/dev/null && continue
    if [[ "$dest" != "$canonical" && -L "$dest" && "$(readlink "$dest")" == "$canonical" ]]; then
      continue
    fi
    if [[ -e "$dest" || -L "$dest" ]]; then
      conflicts+=("$dest")
    fi
  done
done

if [[ ${#conflicts[@]} -gt 0 && "$force" -ne 1 ]]; then
  for dest in "${conflicts[@]}"; do
    echo "Destination already exists: $dest" >&2
  done
  fail "use --force to replace"
fi

link_skill() {
  local link_root="$1" name="$2" canonical="$3"
  local link="$link_root/$name"

  if [[ "$link" == "$canonical" ]]; then
    return
  fi
  if [[ -L "$link" && "$(readlink "$link")" == "$canonical" ]]; then
    echo "Link already in place: $link"
    return
  fi
  if [[ -e "$link" || -L "$link" ]]; then
    rm -rf "$link"
  fi
  mkdir -p "$link_root"
  ln -s "$canonical" "$link"
  echo "Linked $link -> $canonical"
}

for src in "${sources[@]}"; do
  name="$(basename "$src")"
  canonical="$canonical_root/$name"

  if [[ -e "$canonical" || -L "$canonical" ]]; then
    rm -rf "$canonical"
  fi
  mkdir -p "$canonical_root"
  cp -R "$src" "$canonical"
  echo "Installed $name to $canonical"

  link_skill "$claude_root" "$name" "$canonical"
  link_skill "$codex_root" "$name" "$canonical"
done

echo "Restart Claude Code / Codex to pick up the skills."
