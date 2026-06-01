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

require_nonempty_file "bun.lockb"
require_file ".node-version"
require_file "tool-versions.json"
require_file ".github/actions/setup-bun-nx/action.yml"

node_version="$(tr -d '[:space:]' <"${repo_root}/.node-version")"
bun_version="$(sed -n 's/.*"bun": "\([^"]*\)".*/\1/p' "${repo_root}/tool-versions.json" | head -n 1)"

[[ -n "$node_version" ]] || fail ".node-version must declare Node"
[[ -n "$bun_version" ]] || fail "tool-versions.json must declare Bun"

require_text "tool-versions.json" "\"node\": \"${node_version}\""
require_text ".github/actions/setup-bun-nx/action.yml" "default: \"${bun_version}\""

require_text "package.json" "\"build:all\""
require_text "package.json" "bun run --filter @evalops/contracts build"
require_text "package.json" "bun run --filter @evalops/maestro-web build"
require_text "package.json" "\"bun:lint\""
require_text "package.json" "\"test:fast\""

require_text "nx.json" "\"cacheableOperations\": [\"build\", \"test\", \"lint\", \"evals\"]"
require_text "project.json" "\"name\": \"maestro\""
require_text "project.json" "\"build:all\""

required_projects=(
  "packages/ai/project.json:@evalops/ai"
  "packages/consumer-sdk/project.json:@evalops/consumer"
  "packages/contracts/project.json:contracts"
  "packages/github-agent/project.json:github-agent"
  "packages/governance/project.json:@evalops/governance"
  "packages/slack-agent/project.json:slack-agent"
  "packages/slack-agent-ui/project.json:slack-agent-ui"
  "packages/tui/project.json:tui"
  "packages/vscode-extension/project.json:vscode-extension"
  "packages/web/project.json:maestro-web"
)

for entry in "${required_projects[@]}"; do
  manifest="${entry%%:*}"
  project_name="${entry#*:}"
  require_text "$manifest" "\"name\": \"${project_name}\""
  require_text "$manifest" "\"targets\""
done

echo "Maestro Bazel contract is in sync with Bun ${bun_version}, Node ${node_version}, and the Nx project graph."
