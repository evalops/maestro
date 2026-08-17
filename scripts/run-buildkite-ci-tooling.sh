#!/usr/bin/env bash
set -euo pipefail

tool_root="${BUILDKITE_BUILD_CHECKOUT_PATH:-$(pwd)}/.buildkite/cache/ci-tools"
mkdir -p "$tool_root/bin"
export PATH="$tool_root/bin:$PATH"

if ! command -v actionlint >/dev/null 2>&1; then
  GOBIN="$tool_root/bin" go install github.com/rhysd/actionlint/cmd/actionlint@v1.7.9
fi

if ! command -v shellcheck >/dev/null 2>&1; then
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) platform="linux.x86_64" ;;
    Linux-aarch64 | Linux-arm64) platform="linux.aarch64" ;;
    Darwin-x86_64) platform="darwin.x86_64" ;;
    Darwin-arm64 | Darwin-aarch64) platform="darwin.aarch64" ;;
    *) echo "unsupported ShellCheck platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
  esac
  archive="$(mktemp)"
  unpack="$(mktemp -d)"
  trap 'rm -f "$archive"; rm -rf "$unpack"' EXIT
  curl --fail --location --silent --show-error --max-time 120 --retry 2 \
    "https://github.com/koalaman/shellcheck/releases/download/v0.11.0/shellcheck-v0.11.0.${platform}.tar.xz" \
    --output "$archive"
  tar -xJf "$archive" -C "$unpack" --strip-components=1
  cp "$unpack/shellcheck" "$tool_root/bin/shellcheck"
fi

if ! command -v zizmor >/dev/null 2>&1; then
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) target="x86_64-unknown-linux-gnu" ;;
    Linux-aarch64 | Linux-arm64) target="aarch64-unknown-linux-gnu" ;;
    Darwin-x86_64) target="x86_64-apple-darwin" ;;
    Darwin-arm64 | Darwin-aarch64) target="aarch64-apple-darwin" ;;
    *) echo "unsupported zizmor platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
  esac
  curl --fail --location --silent --show-error --max-time 120 --retry 2 \
    "https://github.com/zizmorcore/zizmor/releases/download/v1.28.0/zizmor-${target}.tar.gz" \
    | tar -xz -C "$tool_root/bin"
fi

actionlint -pyflakes=
zizmor --offline --min-severity=high --format=plain .github/workflows/ .github/actions/

shell_files="$(mktemp)"
trap 'rm -f "$shell_files"' EXIT
while IFS= read -r file; do
  [[ -f "$file" ]] || continue
  [[ "$file" == packages/jetbrains-plugin/gradlew ]] && continue
  if [[ "$file" == *.sh ]] || head -1 "$file" 2>/dev/null | grep -Eq '^#!.*sh'; then
    printf '%s\n' "$file" >> "$shell_files"
  fi
done < <(git ls-files)
[[ -s "$shell_files" ]] || { echo "shell file discovery returned no files" >&2; exit 1; }
while IFS= read -r file; do
  shellcheck --external-sources --source-path=SCRIPTDIR "$file"
done < "$shell_files"

timeout --signal=TERM --kill-after=10s 5m npm ci --ignore-scripts
node scripts/check-workflow-footguns.mjs
node --test scripts/check-ci-concurrency.test.mjs
for test_file in \
  scripts/check-required-status-checks.test.mjs \
  scripts/check-integration-required-gate.test.mjs \
  scripts/check-review-thread-guard-workflow.test.mjs \
  scripts/check-sync-public-release-mirror-workflow.test.mjs \
  scripts/update-behind-auto-merge-prs.test.mjs; do
  if [[ -f "$test_file" ]]; then
    node --test "$test_file"
  fi
done
