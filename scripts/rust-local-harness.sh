#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGES=(
	"packages/ambient-agent-rs/Cargo.toml"
	"packages/control-plane-rs/Cargo.toml"
	"packages/tui-rs/Cargo.toml"
)

cd "$ROOT"

for manifest in "${PACKAGES[@]}"; do
	echo "==> cargo fmt --check: $manifest"
	cargo fmt --manifest-path "$manifest" -- --check
done

for manifest in "${PACKAGES[@]}"; do
	echo "==> cargo test: $manifest"
	cargo test --manifest-path "$manifest"
done

for manifest in "${PACKAGES[@]}"; do
	echo "==> cargo clippy -D warnings: $manifest"
	cargo clippy --manifest-path "$manifest" --all-targets -- -D warnings
done
