#!/usr/bin/env bash
# Enforce rustfmt on packages/tui-rs (CI + local).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT/packages/tui-rs/Cargo.toml"

if [[ ! -f "$MANIFEST" ]]; then
  echo "packages/tui-rs/Cargo.toml not found; nothing to check."
  exit 0
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "error: cargo is required for rustfmt checks." >&2
  exit 1
fi

cargo fmt --manifest-path "$MANIFEST" -- --check
echo "rustfmt check passed for packages/tui-rs."
