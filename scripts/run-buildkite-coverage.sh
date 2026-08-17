#!/usr/bin/env bash
set -euo pipefail

tool_root="${BUILDKITE_BUILD_CHECKOUT_PATH:-$(pwd)}/.buildkite/cache/cargo-tools"
mkdir -p "$tool_root"
export CARGO_INSTALL_ROOT="$tool_root"
export PATH="$tool_root/bin:$PATH"

if ! command -v cargo-llvm-cov >/dev/null 2>&1 || [[ "$(cargo llvm-cov --version)" != "cargo-llvm-cov 0.9.0" ]]; then
  timeout --signal=TERM --kill-after=30s 20m cargo install cargo-llvm-cov --version 0.9.0 --locked --force
fi
timeout --signal=TERM --kill-after=30s 75m cargo llvm-cov --workspace --locked --no-report
cargo llvm-cov report --summary-only
mkdir -p coverage-report
cargo llvm-cov report --lcov --output-path coverage-report/lcov.info
cargo llvm-cov report --html --output-dir coverage-report/html
buildkite-agent artifact upload 'coverage-report/**/*'
