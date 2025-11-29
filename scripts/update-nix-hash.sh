#!/usr/bin/env bash
set -euo pipefail

# Recompute npmDepsHash for flake.nix after dependencies change.

if ! command -v nix >/dev/null 2>&1; then
  echo "nix is required to compute npmDepsHash" >&2
  exit 1
fi

# Ensure deps are installed (skip scripts to avoid side effects)
if [ -f package-lock.json ]; then
  npm ci --ignore-scripts >/dev/null
elif [ -f bun.lockb ]; then
  bun install --ignore-scripts >/dev/null
else
  echo "No package-lock.json or bun.lockb found; cannot install deps" >&2
  exit 1
fi

HASH=$(nix hash path ./node_modules)

tmpfile=$(mktemp)
current=$(sed -n 's/.*npmDepsHash = "\(sha256-[^"]*\)".*/\1/p' flake.nix | head -n1 || true)
if [ -z "$current" ]; then
  echo "Failed to find npmDepsHash in flake.nix" >&2
  rm -f "$tmpfile"
  exit 1
fi

if [ "$current" = "$HASH" ]; then
  echo "npmDepsHash already up to date (${HASH})"
  rm -f "$tmpfile"
  exit 0
fi

sed "s|npmDepsHash = \"${current}\"|npmDepsHash = \"${HASH}\"|" flake.nix >"$tmpfile"

if ! grep -q "${HASH}" "$tmpfile"; then
  echo "Failed to update npmDepsHash in flake.nix" >&2
  rm -f "$tmpfile"
  exit 1
fi

mv "$tmpfile" flake.nix
echo "Updated flake.nix npmDepsHash from ${current} to ${HASH}"
