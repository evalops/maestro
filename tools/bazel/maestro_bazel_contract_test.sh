#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${TEST_SRCDIR:-}" && -n "${TEST_WORKSPACE:-}" && -d "${TEST_SRCDIR}/${TEST_WORKSPACE}" ]]; then
  repo_root="${TEST_SRCDIR}/${TEST_WORKSPACE}"
elif git_root="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  repo_root="$git_root"
else
  repo_root="$(pwd)"
fi

fail() {
  echo "maestro bazel contract: $*" >&2
  exit 1
}

require_file() {
  local path="$1"
  [[ -f "${repo_root}/${path}" ]] || fail "missing ${path}"
}

require_nonempty_file() {
  local path="$1"
  require_file "$path"
  [[ -s "${repo_root}/${path}" ]] || fail "${path} must not be empty"
}

require_text() {
  local path="$1"
  local needle="$2"
  require_file "$path"
  grep -Fq "$needle" "${repo_root}/${path}" || fail "${path} must contain ${needle}"
}

require_file ".node-version"
require_file "tool-versions.json"

node_version="$(tr -d '[:space:]' <"${repo_root}/.node-version")"

[[ -n "$node_version" ]] || fail ".node-version must declare Node"

require_text "tool-versions.json" "\"node\": \"${node_version}\""

require_text "package.json" "\"build:all\""
require_text "package.json" "cargo check --workspace"
require_text "package.json" "check:rust-only-runtime"
require_nonempty_file "Cargo.lock"
require_text "Cargo.toml" "[workspace]"

for crate in ambient-agent-rs control-plane-rs maestro-rs tui-rs; do
  require_file "packages/${crate}/Cargo.toml"
done

echo "Maestro Bazel contract is in sync with the unified Rust workspace."
