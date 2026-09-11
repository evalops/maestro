#!/usr/bin/env bash
# Exercise both language clients against the real native stdio bridge with a
# deterministic provider available only in the test-support fixture binary.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd "${script_dir}/../../.." && pwd -P)"
cd "${repo_root}"

test -f sdk/maestro/python/tests/test_native_conformance.py
test -f sdk/maestro/agent-typescript/test/native-conformance.mjs

export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
export RUST_TEST_THREADS="${RUST_TEST_THREADS:-2}"

cargo build --manifest-path products/maestro/Cargo.toml \
  -p maestro --bin maestro-local-sdk-conformance --features test-support --locked
target_directory="$(cargo metadata --manifest-path products/maestro/Cargo.toml \
  --format-version 1 --no-deps --locked | \
  python3 -c 'import json, sys; print(json.load(sys.stdin)["target_directory"])')"
export MAESTRO_LOCAL_SDK_CONFORMANCE_BIN="${target_directory}/debug/maestro-local-sdk-conformance"
if [[ ! -x "${MAESTRO_LOCAL_SDK_CONFORMANCE_BIN}" ]]; then
  echo "Native SDK conformance binary is missing or not executable" >&2
  exit 1
fi

python3 -m unittest discover -s sdk/maestro/python/tests -p test_native_conformance.py
npm --prefix sdk/maestro/agent-typescript ci --ignore-scripts
npm --prefix sdk/maestro/agent-typescript run test:native
