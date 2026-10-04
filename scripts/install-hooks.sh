#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
command -v gitleaks >/dev/null || { echo "Install Gitleaks: brew install gitleaks" >&2; exit 1; }
current=$(git config --get core.hooksPath || true)
if [[ -n "$current" && "$current" != .githooks ]]; then
  echo "Refusing to replace existing hooksPath: $current" >&2; exit 1
fi
if [[ -z "$current" && -f "$(git rev-parse --git-path hooks/pre-commit)" ]]; then
  echo "Existing pre-commit hook found; integrate scripts/secret-scan.sh staged manually." >&2; exit 1
fi
git config --local core.hooksPath .githooks
echo "Installed staged-secret check for this clone."
