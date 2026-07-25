#!/usr/bin/env bash
# Install every skill in this checkout's skills/ directory into
# ${AGENTS_HOME:-~/.agents}/skills, then symlink the Claude (~/.claude/skills)
# and Codex (${CODEX_HOME:-~/.codex}/skills) entries to those canonical copies.
set -euo pipefail

usage() {
  echo "Usage: $(basename "$0") [--force]" >&2
  echo "  --force  Replace existing installed skills." >&2
}

force=0
case "${1:-}" in
  "") ;;
  -f|--force) force=1 ;;
  -h|--help) usage; exit 0 ;;
  *) usage; exit 2 ;;
esac

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
canonical_root="${AGENTS_HOME:-$HOME/.agents}/skills"

link_skill() {
  local link_root="$1"
  local name="$2"
  local canonical="$3"
  local link="$link_root/$name"

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

install_skill() {
  local src="$1"
  local name
  name="$(basename "$src")"
  local canonical="$canonical_root/$name"

  if [[ -e "$canonical" || -L "$canonical" ]]; then
    if [[ "$force" -ne 1 ]]; then
      echo "Destination already exists: $canonical (use --force to replace)" >&2
      exit 1
    fi
    rm -rf "$canonical"
  fi

  mkdir -p "$canonical_root"
  cp -R "$src" "$canonical"
  echo "Installed $name to $canonical"

  link_skill "$HOME/.claude/skills" "$name" "$canonical"
  link_skill "${CODEX_HOME:-$HOME/.codex}/skills" "$name" "$canonical"
}

found=0
for src in "$repo_root"/skills/*/; do
  [[ -f "$src/SKILL.md" ]] || continue
  found=1
  install_skill "${src%/}"
done

if [[ "$found" -eq 0 ]]; then
  echo "No skills found under $repo_root/skills" >&2
  exit 1
fi

echo "Restart Claude Code / Codex to pick up the skills."
