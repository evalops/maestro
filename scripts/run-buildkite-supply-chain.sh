#!/usr/bin/env bash
set -euo pipefail

tool_root="${BUILDKITE_BUILD_CHECKOUT_PATH:-$(pwd)}/.buildkite/cache/cargo-tools"
mkdir -p "$tool_root"
export CARGO_INSTALL_ROOT="$tool_root"
export PATH="$tool_root/bin:$PATH"

if ! deny_version="$(cargo deny --version 2>/dev/null)" || [[ "$deny_version" != "cargo-deny 0.19.9" ]]; then
  timeout --signal=TERM --kill-after=30s 20m cargo install cargo-deny --version 0.19.9 --locked --force
fi
timeout --signal=TERM --kill-after=10s 2m cargo deny fetch db
node --test scripts/check-new-deps-supply-chain.test.mjs scripts/check-advisory-expiry.test.mjs
node scripts/check-advisory-expiry.mjs
timeout --signal=TERM --kill-after=30s 20m cargo deny check --disable-fetch
