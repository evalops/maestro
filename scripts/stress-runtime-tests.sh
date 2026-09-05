#!/usr/bin/env bash
# Exercise containment and global-state fixtures under concurrent test scheduling.
set -euo pipefail
iterations="${1:-10}"
if [[ ! "$iterations" =~ ^[1-9][0-9]*$ ]] || (( iterations > 100 )); then
  echo "usage: $0 [iterations: 1-100]" >&2
  exit 2
fi
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "${script_dir}/.."
for ((iteration = 1; iteration <= iterations; iteration++)); do
  cargo test --locked -p maestro-tui --lib tools::process_utils::tests -- --test-threads=32
  cargo test --locked -p maestro-tui --lib config::tests -- --test-threads=32
done
