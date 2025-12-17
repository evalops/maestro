#!/usr/bin/env bash
set -euo pipefail

: "${NX_BASE:?NX_BASE is required}"
: "${NX_HEAD:?NX_HEAD is required}"

ensure_sha() {
	local sha="$1"
	if git cat-file -e "${sha}^{commit}" 2>/dev/null; then
		return 0
	fi
	git fetch --no-tags origin "$sha"
}

ensure_sha "$NX_BASE"
ensure_sha "$NX_HEAD"

if git diff --name-only "$NX_BASE" "$NX_HEAD" | grep -qE '^(nx\.json|project\.json|tsconfig\.base\.json|package\.json|bun\.lockb|package-lock\.json|packages/.*/project\.json)$'; then
	cmd=(npx nx run-many -t test --all --parallel=3)
else
	cmd=(npx nx affected -t test --base="$NX_BASE" --head="$NX_HEAD" --parallel=3)
fi

run_attempt() {
	local attempt="$1"
	local logfile="nx-tests-attempt-${attempt}.log"

	echo "Running: ${cmd[*]}"
	echo "Attempt ${attempt}..."

	set +e
	"${cmd[@]}" 2>&1 | tee "$logfile"
	local status="${PIPESTATUS[0]}"
	set -e

	return "$status"
}

if run_attempt 1; then
	exit 0
fi

echo "::warning::Nx tests failed; retrying once to detect flaky failures"

if run_attempt 2; then
	{
		echo "## Flaky test detection"
		echo ""
		echo "- Attempt 1: failed"
		echo "- Attempt 2: passed"
		echo ""
		echo "This indicates a flaky test/task. Please fix flakiness instead of relying on retries."
	} >>"${GITHUB_STEP_SUMMARY:-/dev/null}" 2>/dev/null || true

	echo "::error::Nx tests passed on retry; flaky tests suspected"
	exit 1
fi

exit 1
