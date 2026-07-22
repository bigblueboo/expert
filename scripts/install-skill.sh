#!/usr/bin/env bash
# Install the skill from this local checkout into ${AGENTS_HOME:-~/.agents}/skills,
# then symlink the Claude (~/.claude/skills) and Codex (${CODEX_HOME:-~/.codex}/skills)
# entries to that canonical copy.
set -euo pipefail

usage() {
  echo "Usage: $(basename "$0") [--force]" >&2
  echo "  --force  Replace an existing installed skill." >&2
}

force=0
case "${1:-}" in
  "") ;;
  -f|--force) force=1 ;;
  -h|--help) usage; exit 0 ;;
  *) usage; exit 2 ;;
esac

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$repo_root/skills/expert"
canonical_root="${AGENTS_HOME:-$HOME/.agents}/skills"
canonical="$canonical_root/expert"

if [[ ! -f "$src/SKILL.md" ]]; then
  echo "Skill source not found at $src" >&2
  exit 1
fi

if [[ -e "$canonical" || -L "$canonical" ]]; then
  if [[ "$force" -ne 1 ]]; then
    echo "Destination already exists: $canonical (use --force to replace)" >&2
    exit 1
  fi
  rm -rf "$canonical"
fi

mkdir -p "$canonical_root"
cp -R "$src" "$canonical"
echo "Installed expert to $canonical"

link_skill() {
  local link_root="$1"
  local link="$link_root/expert"

  if [[ -L "$link" && "$(readlink "$link")" == "$canonical" ]]; then
    echo "Link already in place: $link"
    return
  fi

  if [[ -e "$link" || -L "$link" ]]; then
    if [[ "$force" -ne 1 ]]; then
      echo "Destination already exists: $link (use --force to replace)" >&2
      exit 1
    fi
    rm -rf "$link"
  fi

  mkdir -p "$link_root"
  ln -s "$canonical" "$link"
  echo "Linked $link -> $canonical"
}

link_skill "$HOME/.claude/skills"
link_skill "${CODEX_HOME:-$HOME/.codex}/skills"

echo "Restart Claude Code / Codex to pick up the skill."
