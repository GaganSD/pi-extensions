#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
command -v gitleaks >/dev/null || { echo "Install Gitleaks: brew install gitleaks" >&2; exit 1; }
case "${1:-history}" in
  staged) exec gitleaks git --pre-commit --staged --redact --no-banner --config .gitleaks.toml . ;;
  history) exec gitleaks git --log-opts="--all" --redact --no-banner --config .gitleaks.toml . ;;
  *) echo "Usage: secret-scan.sh [staged|history]" >&2; exit 1 ;;
esac
