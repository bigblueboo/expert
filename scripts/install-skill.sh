#!/usr/bin/env bash
# Install the Codex skill from this local checkout into ${CODEX_HOME:-~/.codex}/skills.
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
dest_root="${CODEX_HOME:-$HOME/.codex}/skills"
dest="$dest_root/expert"

if [[ ! -f "$src/SKILL.md" ]]; then
  echo "Skill source not found at $src" >&2
  exit 1
fi

if [[ -e "$dest" ]]; then
  if [[ "$force" -ne 1 ]]; then
    echo "Destination already exists: $dest (use --force to replace)" >&2
    exit 1
  fi
  rm -rf "$dest"
fi

mkdir -p "$dest_root"
cp -R "$src" "$dest"

echo "Installed expert to $dest"
echo "Restart Codex to pick up the skill."
