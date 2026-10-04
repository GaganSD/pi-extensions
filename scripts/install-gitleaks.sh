#!/usr/bin/env bash
set -euo pipefail
# CI uses a pinned CLI binary, not a licensed Action or a mutable Docker tag.
version=8.30.1
checksum=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || {
  echo "For local use: brew install gitleaks" >&2; exit 1;
}
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
curl --fail --silent --show-error --location \
  "https://github.com/gitleaks/gitleaks/releases/download/v${version}/gitleaks_${version}_linux_x64.tar.gz" \
  --output "$temporary/gitleaks.tar.gz"
echo "$checksum  $temporary/gitleaks.tar.gz" | sha256sum --check --status
mkdir -p "$HOME/.local/bin"
tar -xzf "$temporary/gitleaks.tar.gz" -C "$HOME/.local/bin" gitleaks
echo "$HOME/.local/bin" >> "$GITHUB_PATH"
