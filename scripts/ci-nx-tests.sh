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

run_shared_memory_tests() {
	if git diff --name-only "$NX_BASE" "$NX_HEAD" | grep -qE '^(src/shared-memory/|test/shared-memory/)'; then
		echo "Running shared memory tests..."
		bunx vitest --run test/shared-memory/ --reporter=verbose
	fi
}

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

append_failed_tasks_summary() {
	local logfile="$1"

	if [[ -z "${GITHUB_STEP_SUMMARY:-}" ]]; then
		return 0
	fi

	{
		echo ""
		echo "### Failed tasks (from ${logfile})"
		echo ""
	} >>"$GITHUB_STEP_SUMMARY" 2>/dev/null || true

	awk '
		/^Failed tasks:/ { in_block=1; next }
		in_block && /^[[:space:]]*-[[:space:]]/ { print $0; next }
		in_block && NF==0 { exit }
	' "$logfile" | sed 's/^/ /' >>"$GITHUB_STEP_SUMMARY" 2>/dev/null || true
}

append_unhandled_error_summary() {
	local logfile="$1"

	if [[ -z "${GITHUB_STEP_SUMMARY:-}" ]]; then
		return 0
	fi

	local start
	start="$(grep -n "Unhandled Error" "$logfile" | head -n1 | cut -d: -f1 || true)"
	if [[ -z "$start" ]]; then
		return 0
	fi

	local end=$((start + 80))
	{
		echo ""
		echo "### Unhandled error excerpt (from ${logfile})"
		echo ""
		echo '```text'
		sed -n "${start},${end}p" "$logfile"
		echo '```'
	} >>"$GITHUB_STEP_SUMMARY" 2>/dev/null || true
}

if run_attempt 1; then
	rm -f nx-tests-attempt-1.log || true
	run_shared_memory_tests
	exit 0
fi

echo "::warning::Nx tests failed; retrying once to detect flaky failures"

if run_attempt 2; then
	{
		echo "## Flaky test detection"
		echo ""
		echo "- Attempt 1: failed"
		echo "- Attempt 2: passed"
		append_failed_tasks_summary "nx-tests-attempt-1.log"
		append_unhandled_error_summary "nx-tests-attempt-1.log"
		echo ""
		echo "This indicates a flaky test/task. Please fix flakiness instead of relying on retries."
	} >>"${GITHUB_STEP_SUMMARY:-/dev/null}" 2>/dev/null || true

	echo "::error::Nx tests passed on retry; flaky tests suspected"
	exit 1
fi

{
	echo "## Nx tests failed"
	echo ""
	echo "- Attempt 1: failed"
	echo "- Attempt 2: failed"
	append_failed_tasks_summary "nx-tests-attempt-2.log"
	append_unhandled_error_summary "nx-tests-attempt-2.log"
} >>"${GITHUB_STEP_SUMMARY:-/dev/null}" 2>/dev/null || true

exit 1
