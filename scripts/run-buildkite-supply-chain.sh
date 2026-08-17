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

pull_request="${BUILDKITE_PULL_REQUEST:-false}"
if [[ "$pull_request" == "false" || -z "$pull_request" ]]; then
  timeout --signal=TERM --kill-after=30s 20m cargo deny check --disable-fetch
  exit 0
fi

base_branch="${BUILDKITE_PULL_REQUEST_BASE_BRANCH:-main}"
timeout --signal=TERM --kill-after=10s 2m git fetch --no-tags origin "+refs/heads/$base_branch:refs/remotes/origin/$base_branch"
base_sha="$(git merge-base HEAD "origin/$base_branch")"
git show "$base_sha:Cargo.lock" > /tmp/base-Cargo.lock
git show "$base_sha:deny.toml" > /tmp/base-deny.toml
test -s /tmp/base-Cargo.lock
test -s /tmp/base-deny.toml

policy_changed=false
if ! git diff --quiet "$base_sha" HEAD -- deny.toml; then
  policy_changed=true
  command -v gh >/dev/null 2>&1 || {
    echo "deny.toml changes require GitHub CLI to verify supply-chain-policy-approved" >&2
    exit 1
  }
  repo_slug="$(printf '%s' "${BUILDKITE_REPO:-}" | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')"
  [[ "$repo_slug" == */* ]] || {
    echo "could not derive GitHub repository from BUILDKITE_REPO" >&2
    exit 1
  }
  latest_commit_at="$(timeout --signal=TERM --kill-after=10s 60s gh api \
    "repos/$repo_slug/pulls/$pull_request/commits?per_page=100" \
    --jq '.[-1].commit.committer.date')"
  latest_approval_at="$(timeout --signal=TERM --kill-after=10s 60s gh api \
    "repos/$repo_slug/issues/$pull_request/events?per_page=100" \
    --jq '[.[] | select(.event == "labeled" and .label.name == "supply-chain-policy-approved")][-1].created_at // empty')"
  if [[ -z "$latest_approval_at" || "$latest_approval_at" < "$latest_commit_at" ]]; then
    echo "deny.toml changes require supply-chain-policy-approved after the latest PR commit" >&2
    exit 1
  fi
fi

git diff --name-only "$base_sha" HEAD \
  | awk '
      /(^|\/)Cargo\.toml$/ ||
      /^package\.json$/ ||
      /^\.github\/workflows\/release\.yml$/ ||
      /^scripts\/build-release-binary\.mjs$/ { print }
    ' > /tmp/changed-dependency-inputs

set +e
timeout --signal=TERM --kill-after=10s 2m cargo deny -f json check --disable-fetch \
  2> /tmp/deny-report.jsonl >/dev/null
deny_status=$?
set -e
if [[ "$deny_status" -ne 0 && ( "$deny_status" -lt 1 || "$deny_status" -gt 15 ) ]]; then
  exit "$deny_status"
fi
if [[ "$deny_status" -ne 0 ]]; then
  node scripts/check-new-deps-supply-chain.mjs \
    --validate-report /tmp/deny-report.jsonl || exit "$deny_status"
fi

if [[ "$policy_changed" == true ]]; then
  set +e
  timeout --signal=TERM --kill-after=10s 2m cargo deny -f json check \
    --config /tmp/base-deny.toml --disable-fetch \
    2> /tmp/base-deny-report.jsonl >/dev/null
  base_status=$?
  set -e
  if [[ "$base_status" -ne 0 && ( "$base_status" -lt 1 || "$base_status" -gt 15 ) ]]; then
    exit "$base_status"
  fi
  if [[ "$base_status" -ne 0 ]]; then
    node scripts/check-new-deps-supply-chain.mjs \
      --validate-report /tmp/base-deny-report.jsonl || exit "$base_status"
    node scripts/check-new-deps-supply-chain.mjs \
      --report /tmp/base-deny-report.jsonl \
      --base-lockfile /tmp/base-Cargo.lock \
      --head-lockfile Cargo.lock \
      --fail-on-preexisting
  fi
fi

dependency_input_args=()
if [[ -s /tmp/changed-dependency-inputs ]]; then
  dependency_input_args+=(--dependency-input-changed)
fi
node scripts/check-new-deps-supply-chain.mjs \
  --report /tmp/deny-report.jsonl \
  --base-lockfile /tmp/base-Cargo.lock \
  --head-lockfile Cargo.lock \
  "${dependency_input_args[@]}"
