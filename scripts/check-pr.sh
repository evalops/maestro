#!/usr/bin/env bash
# Run the repo's PR gates locally (rustfmt, clippy, tests).
# With a crate name, scopes the tests to that crate; with no arguments,
# runs the workspace-wide gates like CI.
#
# Clippy always runs workspace-wide, even when a crate is named: CI's
# rust-validation gate is `cargo clippy --workspace`, and a crate-scoped
# clippy misses cross-crate type breaks (a maestro-tui signature change
# shipped a maestro-runtime-gateway compile error exactly this way).
set -euo pipefail

usage() {
  echo "usage: $0 [crate]" >&2
  echo "  crate  Cargo package name (e.g. maestro, maestro-tui, maestro-runtime-gateway, ambient-agent)." >&2
  echo "         Scopes tests to the crate; clippy stays workspace-wide to match CI." >&2
  echo "         Omit to run workspace-wide checks." >&2
}

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
esac

if [[ $# -gt 1 ]]; then
  usage
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "error: cargo is required for PR checks." >&2
  exit 1
fi

CRATE="${1:-}"

if [[ -n "$CRATE" ]]; then
  cargo fmt --all -- --check
  cargo clippy --workspace --all-targets --locked -- -D warnings
  cargo test -p "$CRATE" --locked
  echo "PR checks passed for crate '$CRATE' (clippy ran workspace-wide)."
else
  cargo fmt --all -- --check
  cargo clippy --workspace --all-targets --locked -- -D warnings
  cargo test --workspace --locked
  echo "PR checks passed for the workspace."
fi
