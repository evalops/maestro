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

NX_TEST_HEARTBEAT_SECONDS="${NX_TEST_HEARTBEAT_SECONDS:-300}"
NX_TEST_ATTEMPT_TIMEOUT_SECONDS="${NX_TEST_ATTEMPT_TIMEOUT_SECONDS:-3300}"
NX_TEST_POST_SUCCESS_IDLE_SECONDS="${NX_TEST_POST_SUCCESS_IDLE_SECONDS:-45}"
NX_TEST_POST_SUCCESS_IDLE_PATTERN="${NX_TEST_POST_SUCCESS_IDLE_PATTERN:-\\bTest Files\\b[^\\n]*\\d+\\s+passed\\b[\\s\\S]*\\bTests\\b[^\\n]*\\d+\\s+passed\\b}"
NX_TEST_POST_SUCCESS_IDLE_FINAL_PATTERN="${NX_TEST_POST_SUCCESS_IDLE_FINAL_PATTERN:-}"

echo "Nx base: $NX_BASE"
echo "Nx head: $NX_HEAD"

changed_files_log="nx-changed-files.log"
affected_projects_log="nx-affected-projects.log"
resolved_targets_log="nx-resolved-targets.log"
ci_timing_file="${CI_TIMING_FILE:-ci-timing.jsonl}"
rm -f "$ci_timing_file"

git diff --name-only "$NX_BASE" "$NX_HEAD" | tee "$changed_files_log"

changed_files_match() {
	local pattern="$1"
	grep -qE "$pattern" "$changed_files_log"
}

run_ci_guardrail_tests() {
	if ! changed_files_match '^(\.github/workflows/.*|scripts/(check-smoke-scripts|ci-nx-tests|plan-ci-checks|plan-nx-test-command|summarize-nx-profile)\.mjs|scripts/ci-nx-tests\.sh|test/scripts/ci-guardrails\.test\.ts)$'; then
		return 0
	fi

	echo "Running CI guardrail tests for workflow/planner changes..."
	node ./scripts/run-vitest.js --run test/scripts/ci-guardrails.test.ts
}

run_smoke_script_static_checks() {
	local smoke_scripts=()
	while IFS= read -r file; do
		[[ -f "$file" ]] || continue
		smoke_scripts+=("$file")
	done < <(grep -E '^scripts/smoke-[^/]+\.[cm]?[jt]sx?$' "$changed_files_log" || true)
	if [[ "${#smoke_scripts[@]}" -eq 0 ]]; then
		return 0
	fi

	echo "Checking changed smoke scripts..."
	node scripts/check-smoke-scripts.mjs "${smoke_scripts[@]}"
}

run_runtime_package_validators() {
	local runtime_validator_plan
	runtime_validator_plan="$(
		node scripts/plan-nx-test-command.mjs \
			--base "$NX_BASE" \
			--head "$NX_HEAD" \
			--runtime-package-validators
	)"
	if [[ "$runtime_validator_plan" != "required" ]]; then
		echo "Skipping runtime package validators; package manifest changes are script-only, metadata-only, or absent."
		return 0
	fi

	echo "Running runtime package validators..."
	node scripts/validate-public-package-deps.js
	npm run build
	node scripts/check-runtime-deps.js
	node scripts/check-docker-runtime-workspaces.mjs
	node scripts/check-packed-bundled-workspaces.mjs
}

run_shared_memory_tests() {
	if git diff --name-only "$NX_BASE" "$NX_HEAD" | grep -qE '^(src/shared-memory/|test/shared-memory/|src/config/env-vars\.ts|src/cli/commands/memory\.ts|src/cli/help\.ts|src/session/manager\.ts)'; then
		echo "Running shared memory tests..."
		bunx vitest --run test/shared-memory/ --reporter=verbose
	fi
}

direct_vitest_files=()
release_helper_script_tests_only() {
	local mode="$1"
	local files_csv="$2"
	if [[ "$mode" != "affected-files" || -z "$files_csv" ]]; then
		return 1
	fi

	IFS=',' read -r -a direct_vitest_files <<<"$files_csv"
	if [[ "${#direct_vitest_files[@]}" -eq 0 ]]; then
		return 1
	fi

	local file
	for file in "${direct_vitest_files[@]}"; do
		case "$file" in
			test/scripts/install-smoke-utils.test.ts | test/scripts/release-context-deps.test.ts | test/scripts/workspace-utils.test.ts)
				;;
			*)
				return 1
				;;
		esac
	done

	return 0
}

node scripts/ensure-deps.js --no-install --workspace @evalops/contracts --workspace @evalops/tui
run_ci_guardrail_tests
run_runtime_package_validators
run_smoke_script_static_checks

nx_plan="$(node scripts/plan-nx-test-command.mjs --base "$NX_BASE" --head "$NX_HEAD")"
nx_mode="$(printf '%s\n' "$nx_plan" | sed -n '1p')"
nx_files="$(printf '%s\n' "$nx_plan" | sed -n '2p')"

echo "Nx test plan: $nx_mode"
if [[ -n "$nx_files" ]]; then
	echo "Nx test files: $nx_files"
fi

case "$nx_mode" in
	all)
		cmd=(npx nx run-many -t test --all --parallel=3)
		;;
	affected-files)
		if release_helper_script_tests_only "$nx_mode" "$nx_files"; then
			echo "Release helper script tests are handled directly by Vitest."
			cmd=(node ./scripts/run-vitest.js --run "${direct_vitest_files[@]}")
		else
			cmd=(npx nx affected -t test --files="$nx_files" --parallel=3)
		fi
		;;
	none)
		echo "No Nx project tests are required for this change set."
		run_shared_memory_tests
		exit 0
		;;
	*)
		echo "::error::Unknown Nx test plan mode: $nx_mode"
		exit 1
		;;
esac

if [[ -z "$NX_TEST_POST_SUCCESS_IDLE_FINAL_PATTERN" && "${cmd[0]}" == "npx" && "${cmd[1]}" == "nx" ]]; then
	NX_TEST_POST_SUCCESS_IDLE_FINAL_PATTERN="\\bSuccessfully ran target\\s+test\\b"
fi

echo "Affected Nx projects:"
if [[ "${cmd[0]}" == "node" && "${cmd[1]}" == "./scripts/run-vitest.js" ]]; then
	printf '%s\n' "direct-vitest" "${direct_vitest_files[@]}" | tee "$affected_projects_log"
else
	case "$nx_mode" in
		all)
			if ! npx nx show projects --affected --base="$NX_BASE" --head="$NX_HEAD" | tee "$affected_projects_log"; then
				echo "::warning::Unable to list affected Nx projects before test execution"
			fi
			;;
		affected-files)
			if ! npx nx show projects --affected --files="$nx_files" | tee "$affected_projects_log"; then
				echo "::warning::Unable to list affected Nx projects before test execution"
			fi
			;;
	esac
fi

write_resolved_targets() {
	case "$nx_mode" in
		all)
			npx nx show projects --withTarget test
			;;
		affected-files)
			npx nx show projects --affected --files="$nx_files" --withTarget test
			;;
	esac | sed 's/$/:test/' | tee "$resolved_targets_log"
}

echo "Resolved Nx test targets:"
if ! write_resolved_targets; then
	echo "::warning::Unable to list resolved Nx test targets before test execution"
	: >"$resolved_targets_log"
fi

summarize_attempt_profile() {
	local profile_file="$1"
	local timing_file="$2"

	if [[ ! -s "$profile_file" ]]; then
		echo "::warning::Nx profile ${profile_file} was not written" | tee "$timing_file"
		return 0
	fi

	if ! node scripts/summarize-nx-profile.mjs \
		--profile "$profile_file" \
		--targets "$resolved_targets_log" | tee "$timing_file"; then
		echo "::warning::Unable to summarize Nx profile ${profile_file}" | tee "$timing_file"
	fi
}

run_attempt() {
	local attempt="$1"
	local logfile="nx-tests-attempt-${attempt}.log"
	local profile_file="nx-profile-attempt-${attempt}.json"
	local timing_file="nx-target-timings-attempt-${attempt}.log"
	local summary_json="nx-tests-attempt-${attempt}.json"

	echo "Running: ${cmd[*]}"
	echo "Attempt ${attempt}..."
	echo "Heartbeat interval: ${NX_TEST_HEARTBEAT_SECONDS}s"
	echo "Attempt timeout: ${NX_TEST_ATTEMPT_TIMEOUT_SECONDS}s"
	echo "Post-success idle timeout: ${NX_TEST_POST_SUCCESS_IDLE_SECONDS}s"
	echo "Nx profile: ${profile_file}"

	rm -f "$profile_file" "$timing_file"
	local -a success_idle_args=(
		--success-idle-seconds "$NX_TEST_POST_SUCCESS_IDLE_SECONDS"
		--success-idle-pattern "$NX_TEST_POST_SUCCESS_IDLE_PATTERN"
	)
	if [[ "${cmd[0]}" == "npx" && "${cmd[1]}" == "nx" ]]; then
		success_idle_args+=(
			--success-idle-final-pattern "$NX_TEST_POST_SUCCESS_IDLE_FINAL_PATTERN"
		)
		echo "Post-success final pattern: $NX_TEST_POST_SUCCESS_IDLE_FINAL_PATTERN"
	fi
	set +e
	NX_PROFILE="$profile_file" node scripts/run-command-with-heartbeat.mjs \
		--label "Nx tests attempt ${attempt}" \
		--logfile "$logfile" \
		--summary-json "$summary_json" \
		--timing-file "$ci_timing_file" \
		--heartbeat-seconds "$NX_TEST_HEARTBEAT_SECONDS" \
		--timeout-seconds "$NX_TEST_ATTEMPT_TIMEOUT_SECONDS" \
		"${success_idle_args[@]}" \
		-- "${cmd[@]}"
	local status="$?"
	set -e

	summarize_attempt_profile "$profile_file" "$timing_file"

	return "$status"
}

append_attempt_summaries() {
	if [[ -z "${GITHUB_STEP_SUMMARY:-}" ]]; then
		return 0
	fi

	{
		echo ""
		echo "#### Attempt summaries"
		for summary_json in nx-tests-attempt-*.json; do
			[[ -f "$summary_json" ]] || continue
			echo ""
			echo "\`${summary_json}\`"
			echo '```json'
			node -e 'const fs=require("node:fs"); const path=process.argv[1]; const summary=JSON.parse(fs.readFileSync(path, "utf8")); console.log(JSON.stringify(summary, null, 2));' "$summary_json"
			echo '```'
		done
	} >>"$GITHUB_STEP_SUMMARY" 2>/dev/null || true
}

append_ci_context_summary() {
	if [[ -z "${GITHUB_STEP_SUMMARY:-}" ]]; then
		return 0
	fi

	{
		echo ""
		echo "### Nx CI context"
		echo ""
		echo "- Base: \`${NX_BASE}\`"
		echo "- Head: \`${NX_HEAD}\`"
		echo "- Heartbeat interval: ${NX_TEST_HEARTBEAT_SECONDS}s"
		echo "- Attempt timeout: ${NX_TEST_ATTEMPT_TIMEOUT_SECONDS}s"
		if [[ -s "$ci_timing_file" ]]; then
			echo ""
			echo "#### CI timings"
			echo ""
			node - "$ci_timing_file" <<'NODE'
import { readFileSync } from "node:fs";

const file = process.argv[2];
const rows = readFileSync(file, "utf8")
	.split(/\r?\n/u)
	.filter(Boolean)
	.map((line) => JSON.parse(line));
console.log("| Step | Status | Duration |");
console.log("|---|---:|---:|");
for (const row of rows) {
	const duration = Number(row.durationMs) || 0;
	console.log(`| ${row.label} | ${row.status} | ${(duration / 1000).toFixed(1)}s |`);
}
NODE
		fi
		echo ""
		echo "#### Changed files"
		echo '```text'
		sed -n '1,120p' "$changed_files_log"
		echo '```'
		echo ""
		echo "#### Affected projects"
		echo '```text'
		sed -n '1,120p' "$affected_projects_log" 2>/dev/null || true
		echo '```'
		echo ""
		echo "#### Resolved Nx test targets"
		echo '```text'
		sed -n '1,160p' "$resolved_targets_log" 2>/dev/null || true
		echo '```'
		if compgen -G 'nx-target-timings-attempt-*.log' >/dev/null; then
			for timing_log in nx-target-timings-attempt-*.log; do
				echo ""
				echo "#### Nx target timings (${timing_log})"
				echo '```text'
				sed -n '1,200p' "$timing_log"
				echo '```'
			done
		fi
	} >>"$GITHUB_STEP_SUMMARY" 2>/dev/null || true
	append_attempt_summaries
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
	append_ci_context_summary
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
		append_ci_context_summary
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
	append_ci_context_summary
	append_failed_tasks_summary "nx-tests-attempt-2.log"
	append_unhandled_error_summary "nx-tests-attempt-2.log"
} >>"${GITHUB_STEP_SUMMARY:-/dev/null}" 2>/dev/null || true

exit 1
